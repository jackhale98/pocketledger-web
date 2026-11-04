-- | No-network stand-in for "Network.HTTP.Client" (see http-client.cabal).
-- Only what hledger's Setup command names. Nothing here can be reached at
-- run time, because the req stand-in fails before any request exists.
module Network.HTTP.Client
  ( HttpException (..)
  , HttpExceptionContent (..)
  , Request
  , Response
  , responseStatus
  , responseHeaders
  ) where

import Control.Exception (Exception)
import Data.ByteString (ByteString)
import Network.HTTP.Types (ResponseHeaders, Status)

data Request = Request deriving (Show)

data Response body = Response deriving (Show)

data HttpExceptionContent
  = StatusCodeException (Response ()) ByteString
  | ConnectionFailure String
  deriving (Show)

data HttpException
  = HttpExceptionRequest Request HttpExceptionContent
  | InvalidUrlException String String
  deriving (Show)

instance Exception HttpException

responseStatus :: Response body -> Status
responseStatus _ = error "http-client (wasm stand-in): no responses exist"

responseHeaders :: Response body -> ResponseHeaders
responseHeaders _ = error "http-client (wasm stand-in): no responses exist"
