/** Repairs the NSIS uninstaller CRC electron-builder's macOS slicer breaks. */
declare function fixNsisCrc(configuration: { path?: string; cscInfo?: unknown }): Promise<void>;
export default fixNsisCrc;
