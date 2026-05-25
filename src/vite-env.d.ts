/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SHIELDED_CREDITS_ADDRESS?: `0x${string}`
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
