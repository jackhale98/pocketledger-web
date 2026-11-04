{-# LANGUAGE ForeignFunctionInterface #-}

-- | Run an IO action with the process-wide @stdout@ and @stderr@ Handles
-- pointed at memory, and return what was written to them.
--
-- hledger writes its reports with plain 'putStr' / 'hPutStrLn' to the global
-- Handles, so redirecting at the Handle level captures everything without
-- touching hledger. WASI has no dup2 and no pipes, so 'hDuplicateTo' cannot be
-- used; instead each Handle's internal state ('Handle__', held in an MVar) is
-- swapped for one built over an in-memory device for the duration of the call,
-- then swapped back. The real WASI fds 1 and 2 are never written.
--
-- Encoding is UTF-8 on both, matching native hledger under a UTF-8 locale.
-- stdout is block-buffered like a native pipe; stderr is unbuffered (as
-- native), and shares a C buffer with Debug.Trace output (see cbits/capture.c)
-- so warnings and error text keep their relative order.
module Capture (withCapturedOutput) where

import Control.Concurrent.MVar (putMVar, readMVar, takeMVar)
import Control.Exception (finally, mask, onException, try, SomeException)
import qualified Data.ByteString as B
import Data.IORef
import Data.Word (Word8, Word64)
import Foreign.C.Types (CSize (..))
import Foreign.Ptr (Ptr, castPtr)
import GHC.IO.Buffer (newByteBuffer)
import GHC.IO.BufferedIO (BufferedIO (..), readBuf, readBufNonBlocking, writeBuf, writeBufNonBlocking)
import qualified GHC.IO.Device as D
import GHC.IO.Handle.Internals (mkHandle)
import GHC.IO.Handle.Types (Handle (..), HandleType (..), Handle__, nativeNewlineMode)
import System.IO (hFlush, stderr, stdout, utf8)

foreign import ccall unsafe "hledger_err_append" c_err_append :: Ptr Word8 -> CSize -> IO ()
foreign import ccall unsafe "hledger_capture_begin" c_capture_begin :: IO ()
foreign import ccall unsafe "hledger_capture_end" c_capture_end :: IO ()
foreign import ccall unsafe "hledger_err_ptr" c_err_ptr :: IO (Ptr Word8)
foreign import ccall unsafe "hledger_err_len" c_err_len :: IO CSize

-- | A write-only in-memory device.
newtype Sink = Sink (Ptr Word8 -> Int -> IO ())

instance D.RawIO Sink where
  read _ _ _ _ = pure 0
  readNonBlocking _ _ _ _ = pure (Just 0)
  write (Sink w) p (_ :: Word64) n = w p n
  writeNonBlocking (Sink w) p _ n = w p n >> pure n

instance D.IODevice Sink where
  ready _ _ _ = pure True
  close _ = pure ()
  isTerminal _ = pure False
  isSeekable _ = pure False
  devType _ = pure D.Stream

instance BufferedIO Sink where
  newBuffer _ = newByteBuffer 65536
  fillReadBuffer = readBuf
  fillReadBuffer0 = readBufNonBlocking
  flushWriteBuffer = writeBuf
  flushWriteBuffer0 = writeBufNonBlocking

sinkHandle__ :: String -> Bool -> Sink -> IO Handle__
sinkHandle__ name buffered sink = do
  h <- mkHandle sink name WriteHandle buffered (Just utf8) nativeNewlineMode Nothing Nothing
  case h of
    FileHandle _ m -> readMVar m
    DuplexHandle _ _ m -> readMVar m

-- | Swap a global Handle's state for the duration of an action.
swapped :: Handle -> Handle__ -> IO a -> IO a
swapped h new act = case h of
  FileHandle _ m -> go m
  DuplexHandle _ _ m -> go m
  where
    go m = mask $ \restore -> do
      old <- takeMVar m
      putMVar m new
      let back = do
            _ <- try (hFlush h) :: IO (Either SomeException ())
            _ <- takeMVar m
            putMVar m old
      (restore act `onException` back) <* back

-- | Run the action, returning (its result, stdout bytes, stderr bytes).
withCapturedOutput :: IO a -> IO (a, B.ByteString, B.ByteString)
withCapturedOutput act = do
  outRef <- newIORef []
  let outSink = Sink $ \p n -> do
        b <- B.packCStringLen (castPtr p, n)
        modifyIORef' outRef (b :)
      errSink = Sink $ \p n -> c_err_append p (fromIntegral n)
  outH <- sinkHandle__ "<stdout>" True outSink
  errH <- sinkHandle__ "<stderr>" False errSink
  c_capture_begin
  r <- swapped stdout outH (swapped stderr errH act) `finally` c_capture_end
  out <- B.concat . reverse <$> readIORef outRef
  ep <- c_err_ptr
  el <- c_err_len
  err <- B.packCStringLen (castPtr ep, fromIntegral el)
  pure (r, out, err)
