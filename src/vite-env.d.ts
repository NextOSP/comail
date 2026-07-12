/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** App version injected at build time from package.json (see vite.config.ts). */
  readonly VITE_APP_VERSION?: string;
  /** Set to "1" to force in-browser mock mode. */
  readonly VITE_MOCK?: string;
}
