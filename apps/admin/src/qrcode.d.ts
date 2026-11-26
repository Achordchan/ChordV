// The part of the `qrcode` package this app uses. Declared here instead of
// installing @types/qrcode, which pulls in @types/node and with it Node's
// timer types — in a browser build that turns every setTimeout handle into a
// NodeJS.Timeout.
declare module "qrcode" {
  export function toDataURL(
    text: string,
    options?: { margin?: number; width?: number; errorCorrectionLevel?: "L" | "M" | "Q" | "H" }
  ): Promise<string>;
  const QRCode: { toDataURL: typeof toDataURL };
  export default QRCode;
}
