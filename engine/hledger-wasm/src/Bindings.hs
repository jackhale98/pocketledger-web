{-# LANGUAGE OverloadedStrings #-}

-- | hledger 1.52.4's command line as a wasm32-wasi reactor module.
--
-- JSFFI exports (synchronous; each returns its value directly):
--
--   hledgerRun(argsJson: string): string
--       argsJson: JSON array of CLI arguments without the program name,
--       e.g. ["-f","/vault/main.journal","bs","-O","json"].
--       Returns JSON {"code":int,"stdout":string,"stderr":string}: what the
--       native `hledger` executable would print and its exit status.
--   hledgerInvalidate(): void
--       Drop every cached journal. Call after changing files in the WASI fs.
--   hledgerVersion(): string        -- "1.52.4"
--
-- The command line is processed by hledger's own code ('CliMain' is a marked
-- copy of Hledger.Cli.main): config file, option parsing with hledger's
-- cmdargs modes, findBuiltinCommand dispatch, journalTransform, and the
-- command's own output. The one difference is where the journal comes from:
-- a parsed journal is kept in memory, keyed by the input files plus every
-- input option (hledger's InputOpts: --forecast, --auto, -I, --strict,
-- --rules, --alias, --infer-*, -c styles, today's date...), and reused until
-- the key changes or hledgerInvalidate is called. This mirrors what
-- hledger's own `run`/`repl` commands do (Hledger.Cli.Commands.Run.
-- withJournalCached), but over all the files together as withJournal reads
-- them, so results are identical to an uncached run.
--
-- Nothing traps the instance: ErrorCall/IOException/UnicodeException are
-- formatted by hledger's own 'handleExit' exactly as the CLI prints them,
-- ExitCode becomes "code", and any other exception is reported the way GHC's
-- top-level handler would ("hledger: <exception>", code 1).
module Main (main) where

import Control.Exception
import Control.Monad (unless, void, when)
import qualified Data.Aeson as A
import qualified Data.ByteString as B
import qualified Data.ByteString.Unsafe as BU
import Data.IORef
import qualified Data.List.NonEmpty as NE
import qualified Data.Map.Strict as M
import qualified Data.Text as T
import qualified Data.Text.Encoding as TE
import Data.Word (Word8)
import Foreign.Ptr (Ptr, castPtr)
import GHC.IO.Encoding (setFileSystemEncoding, setForeignEncoding, setLocaleEncoding)
import GHC.Wasm.Prim (JSString (..), fromJSString, toJSString)
import System.Environment (lookupEnv, setEnv, withArgs, withProgName)
import System.Exit (ExitCode (..))
import System.IO (hPutStrLn, stderr, utf8)
import System.IO.Unsafe (unsafePerformIO)

import Hledger
import Hledger.Cli.CliOptions (CliOpts (..), journalFilePathFromOpts)
import Hledger.Cli.Utils (journalTransform)
import Hledger.Cli.Version (packageversion)

import Capture (withCapturedOutput)
import CliMain (Hooks (..), cliMain)

foreign export javascript "hledgerRun sync" hledgerRun :: JSString -> IO JSString
foreign export javascript "hledgerInvalidate sync" hledgerInvalidate :: IO ()
foreign export javascript "hledgerVersion sync" hledgerVersion :: IO JSString

-- Build the response object on the JS side: decode the captured UTF-8 bytes
-- straight out of linear memory and let JSON.stringify do the escaping. Doing
-- this in Haskell (String/Text + aeson) costs a few passes over what can be a
-- multi-megabyte report; V8 does it in a millisecond or two. Invalid UTF-8
-- (which hledger does not produce) would decode to U+FFFD.
foreign import javascript unsafe
  "(() => { const m = __exports.memory.buffer, d = new TextDecoder('utf-8'); \
  \return JSON.stringify({code: $1, stdout: d.decode(new Uint8Array(m, $2, $3)), \
  \stderr: d.decode(new Uint8Array(m, $4, $5))}); })()"
  js_respond :: Int -> Ptr Word8 -> Int -> Ptr Word8 -> Int -> IO JSString

-- A reactor module still needs a main; it is never run.
main :: IO ()
main = pure ()

------------------------------------------------------------------------------
-- Exports

hledgerVersion :: IO JSString
hledgerVersion = pure (toJSString packageversion)

hledgerInvalidate :: IO ()
hledgerInvalidate = writeIORef journalCache M.empty

hledgerRun :: JSString -> IO JSString
hledgerRun jsargs = do
  ensureInit
  r <- try (evaluate (decodeArgs (fromJSString jsargs)))
  case r of
    Left (e :: SomeException) -> respond 1 "" (utf8Bytes ("hledger: Error: " <> displayException e <> "\n"))
    Right (Left msg) -> respond 1 "" (utf8Bytes ("hledger: Error: hledgerRun: " <> msg <> "\n"))
    Right (Right args) -> do
      (code, out, err) <- withCapturedOutput (runCli args)
      respond code out err

decodeArgs :: String -> Either String [String]
decodeArgs s = case A.eitherDecodeStrict' (TE.encodeUtf8 (T.pack s)) of
  Left e -> Left ("expected a JSON array of strings: " <> e)
  Right ts -> Right (map T.unpack ts)

utf8Bytes :: String -> B.ByteString
utf8Bytes = TE.encodeUtf8 . T.pack

respond :: Int -> B.ByteString -> B.ByteString -> IO JSString
respond code out err =
  BU.unsafeUseAsCStringLen out $ \(po, no) ->
    BU.unsafeUseAsCStringLen err $ \(pe, ne) ->
      js_respond code (castPtr po) no (castPtr pe) ne

------------------------------------------------------------------------------
-- Running one command line

-- | Run hledger's CLI on these arguments, as if they were argv; return the
-- exit status. Never throws.
runCli :: [String] -> IO Int
runCli args =
  withProgName "hledger" . withArgs args $ do
    r <- try (try (handleExit (cliMain (hooks args))))
    case r of
      Right (Right ()) -> pure 0
      Right (Left ExitSuccess) -> pure 0
      Right (Left (ExitFailure n)) -> pure n
      Left (e :: SomeException) -> do
        -- What GHC's top-level handler prints for an exception hledger's
        -- handleExit does not format itself.
        void (try (hPutStrLn stderr ("hledger: " <> displayException e)) :: IO (Either SomeException ()))
        pure 1

hooks :: [String] -> Hooks
hooks args = Hooks {hWithJournal = cachedWithJournal args, hJournalWritten = hledgerInvalidate}

------------------------------------------------------------------------------
-- The parse cache

-- | Input files (as given, with any reader prefix) and the input options
-- they were read with.
type CacheKey = (InputOpts, [PrefixedFilePath])

{-# NOINLINE journalCache #-}
journalCache :: IORef (M.Map CacheKey Journal)
journalCache = unsafePerformIO (newIORef M.empty)

-- | How many distinct (files, options) combinations to keep.
cacheLimit :: Int
cacheLimit = 8

-- | Like hledger's withJournal (Hledger.Cli.Utils), reading through the cache.
--
-- hledger's journalFinalise also looks at the *process* arguments (via the
-- progArgs CAF, which in a long-lived instance is evaluated once and frozen;
-- see 'ensureInit') for two parse-time checks: "check ... assertions" forces
-- assertion checking even with -I, and "check ... ordereddates" checks dates
-- before balancing. Both are reproduced here from this call's arguments.
cachedWithJournal :: [String] -> CliOpts -> (Journal -> IO a) -> IO a
cachedWithJournal args opts cmd = do
  paths <- NE.toList <$> journalFilePathFromOpts opts
  let checking name = "check" `elem` args && name `elem` args
      iopts0 = inputopts_ opts
      iopts
        | checking "assertions" = setIgnoreAssertions False iopts0
        | otherwise = iopts0
  ej <- readJournalFilesCached iopts paths
  j <- case ej of
    Right j
      | checking "ordereddates", Left e <- checkOrderedDatesUnbalanced j -> error' e
      | otherwise -> pure j
    Left e
      | checking "ordereddates" -> do
          -- natively the date-order check runs before transaction balancing,
          -- so its error wins over a balance assertion failure
          ej' <- readJournalFilesCached (setIgnoreAssertions True iopts) paths
          case ej' of
            Right j' | Left oe <- checkOrderedDatesUnbalanced j' -> error' oe
            _ -> error' e
      | otherwise -> error' e
  cmd (journalTransform opts j)

-- | journalCheckOrdereddates as journalFinalise runs it: before transaction
-- balancing, so its error excerpt shows postings as written (no inferred
-- amounts). Balancing keeps the as-written posting in poriginal.
checkOrderedDatesUnbalanced :: Journal -> Either String ()
checkOrderedDatesUnbalanced j =
  journalCheckOrdereddates
    j {jtxns = [t {tpostings = map originalPosting (tpostings t)} | t <- jtxns j]}

setIgnoreAssertions :: Bool -> InputOpts -> InputOpts
setIgnoreAssertions b io = io {balancingopts_ = (balancingopts_ io) {ignore_assertions_ = b}}

readJournalFilesCached :: InputOpts -> [PrefixedFilePath] -> IO (Either String Journal)
readJournalFilesCached iopts paths
  -- --new reads and updates .latest state, and stdin is read once: never cache
  | new_ iopts || any isStdin paths = runExceptT (readJournalFiles iopts paths)
  | otherwise = do
      let key = (cacheKeyOpts iopts, paths)
      cache <- readIORef journalCache
      case M.lookup key cache of
        Just j -> pure (Right j)
        Nothing -> do
          r <- runExceptT (readJournalFiles iopts paths)
          case r of
            Right j -> modifyIORef' journalCache $ \c ->
              M.insert key j (if M.size c >= cacheLimit then M.empty else c)
            Left _ -> pure ()
          pure r

-- | InputOpts as far as they can change the parsed journal. The report period
-- is copied into InputOpts only so that --forecast can default its period from
-- it, so it is irrelevant without --forecast (as in hledger's withJournalCached).
cacheKeyOpts :: InputOpts -> InputOpts
cacheKeyOpts io = case forecast_ io of
  Nothing -> io {reportspan_ = nulldatespan}
  Just _ -> io

------------------------------------------------------------------------------
-- One-time setup

{-# NOINLINE initialised #-}
initialised :: IORef Bool
initialised = unsafePerformIO (newIORef False)

-- | Make the process-wide state hledger reads match a native run with
-- redirected output, before the first command line runs:
--
--  * UTF-8 for files, stdout and stderr (native under a UTF-8 locale).
--  * HOME: hledger's config-file lookup calls getHomeDirectory, which fails
--    under WASI without it. The default points at a directory that does not
--    exist, so no user config is found (pass --conf to use one).
--  * PATH: the pager lookup (findExecutable) fails under WASI without it.
--    The default is a directory that does not exist: no pager, no programs.
--  * hledger-lib reads a few things through unsafePerformIO CAFs that are
--    evaluated once per process: progArgs (for --debug and the two parse-time
--    checks handled in 'cachedWithJournal') and the "is stdout/stderr a
--    colour terminal" flags. A native process evaluates them for its one
--    command line; here they are evaluated now, with no arguments and with
--    output captured (so: not a terminal), so that they do not freeze to
--    whatever the first call happened to pass.
ensureInit :: IO ()
ensureInit = do
  done <- readIORef initialised
  unless done $ do
    writeIORef initialised True
    setLocaleEncoding utf8
    setFileSystemEncoding utf8
    setForeignEncoding utf8
    let defaultEnv name value = do
          v <- lookupEnv name
          when (maybe True null v) $ setEnv name value
    defaultEnv "HOME" "/home/hledger"
    defaultEnv "PATH" "/nonexistent/bin"
    void . withCapturedOutput . withArgs [] $ do
      _ <- try (evaluate (length progArgs)) :: IO (Either SomeException Int)
      _ <- try (evaluate debugLevel) :: IO (Either SomeException Int)
      _ <- try (evaluate useColorOnStdoutUnsafe) :: IO (Either SomeException Bool)
      _ <- try (evaluate useColorOnStderrUnsafe) :: IO (Either SomeException Bool)
      pure ()
