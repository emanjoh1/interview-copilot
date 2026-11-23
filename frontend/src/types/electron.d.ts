declare global {
  interface Window {
    copilot: {
      // Session transcript storage
      saveSession: (data: object) => Promise<{ success: boolean; filename?: string; error?: string }>
      listSessions: () => Promise<Array<{ filename: string; savedAt: string | null; turnCount: number; duration: string | null; jobTitle: string | null }>>
      loadSession: (filename: string) => Promise<{ success: boolean; data?: SessionFile; error?: string }>
      openSessionsFolder: () => Promise<void>

      // Window controls
      minimizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;

      // Visibility
      toggleVisibility: () => Promise<{ visible: boolean }>;
      showWindow: () => Promise<{ visible: boolean }>;

      // Screenshot — returns data URL or error
      captureScreenshot: () => Promise<{ dataUrl: string } | { error: string }>;

      // Window geometry
      getWindowBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
      setWindowPosition: (x: number, y: number) => Promise<{ x: number; y: number } | undefined>;
      resizeWindow: (width: number, height: number) => Promise<{ width: number; height: number } | undefined>;

      // Content protection toggle
      setContentProtection: (enabled: boolean) => Promise<{ contentProtection: boolean }>;

      // Main → renderer push: Cmd+H screenshot
      onScreenshot: (callback: (payload: { dataUrl: string }) => void) => void;
      offScreenshot: () => void;
    };
  }
}
export {};

