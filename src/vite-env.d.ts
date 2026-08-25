/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FEATURE_LEARNING?: string;
}

declare const __YUANYUAN_LEARNING_ENABLED__: boolean;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
