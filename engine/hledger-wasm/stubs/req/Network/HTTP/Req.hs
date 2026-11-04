-- | No-network stand-in for "Network.HTTP.Req" (see req.cabal).
-- The names and shapes are the subset hledger's Setup command uses; running
-- any request throws 'JsonHttpException', which Setup catches.
module Network.HTTP.Req
  ( Req
  , runReq
  , req
  , HttpConfig (..)
  , defaultHttpConfig
  , HttpException (..)
  , GET (..)
  , HEAD (..)
  , NoReqBody (..)
  , Url
  , http
  , https
  , (/:)
  , Option
  , responseTimeout
  , BsResponse
  , bsResponse
  , responseBody
  ) where

import Control.Exception (Exception, throwIO)
import Control.Monad.IO.Class (MonadIO (..))
import Data.ByteString (ByteString)
import Data.Proxy (Proxy (..))
import Data.Text (Text)
import qualified Data.Text as T
import qualified Network.HTTP.Client as C

newtype Url = Url Text

http, https :: Text -> Url
http = Url
https = Url

infixl 5 /:
(/:) :: Url -> Text -> Url
Url u /: s = Url (u `T.append` T.pack "/" `T.append` s)

data GET = GET
data HEAD = HEAD
data NoReqBody = NoReqBody
data Option = Option

responseTimeout :: Int -> Option
responseTimeout _ = Option

newtype BsResponse = BsResponse ByteString

bsResponse :: Proxy BsResponse
bsResponse = Proxy

responseBody :: BsResponse -> ByteString
responseBody (BsResponse b) = b

newtype HttpConfig = HttpConfig {httpConfigRedirectCount :: Int}

defaultHttpConfig :: HttpConfig
defaultHttpConfig = HttpConfig 10

data HttpException
  = VanillaHttpException C.HttpException
  | JsonHttpException String
  deriving (Show)

instance Exception HttpException

newtype Req a = Req (IO a)

instance Functor Req where fmap f (Req a) = Req (fmap f a)
instance Applicative Req where
  pure = Req . pure
  Req f <*> Req a = Req (f <*> a)
instance Monad Req where Req a >>= k = Req (a >>= \x -> let Req b = k x in b)
instance MonadIO Req where liftIO = Req

runReq :: MonadIO m => HttpConfig -> Req a -> m a
runReq _ (Req a) = liftIO a

req :: method -> Url -> body -> Proxy response -> Option -> Req response
req _ _ _ _ _ = Req (throwIO (JsonHttpException "no network in the wasm build"))
