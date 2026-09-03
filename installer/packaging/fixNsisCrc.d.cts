/** Repairs the NSIS uninstaller CRC electron-builder's macOS slicer breaks. */
declare function fixNsisCrc(configuration: { path?: string }): Promise<void>;
export default fixNsisCrc;
