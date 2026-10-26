/** @param {ReadonlyArray<{type: string, png: Uint8Array}>} entries */
export function encodePngIcns(entries) {
  const chunks = entries.map(({ type, png }) => {
    if (!/^[a-zA-Z0-9]{4}$/.test(type))
      throw new Error("ICNS entry codes must have four characters.");
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}
