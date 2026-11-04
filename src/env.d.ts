/// <reference types="astro/client" />
interface ImportMetaEnv {
  readonly PUBLIC_GIT_PROXY?: string;
  readonly PUBLIC_DROPBOX_APP_KEY?: string;
  readonly PUBLIC_GITHUB_CLIENT_ID?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
declare const __ENGINE__: {
  file: string;
  sha256: string;
  hledger: string;
  flavor: string;
  reactor: { file: string; jsffi: string; sha256: string } | null;
};
declare const __APP_VERSION__: string;
