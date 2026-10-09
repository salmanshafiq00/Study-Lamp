/** @type {import('next').NextConfig} */

const isDev = process.env.NODE_ENV !== "production";
const enforceCsp = process.env.CSP_MODE === "enforce";

// The Firebase Auth popup/iframe is served from the project's authDomain (may be a custom domain).
const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
const authDomainOrigin = authDomain ? `https://${authDomain}` : "";

/**
 * Content-Security-Policy.
 * Shipped as REPORT-ONLY by default: violations are logged in the browser console, nothing is blocked.
 * To enforce after a clean test week, set CSP_MODE=enforce at build time and redeploy (see docs/deploy.md).
 *
 * Origin list is derived from the code (grep of src/):
 *  - apis.google.com            Drive Picker + Firebase popup auth load gapi (DrivePickerButton.tsx)
 *  - www.gstatic.com            Picker / gapi sub-scripts and assets
 *  - accounts.google.com        Google sign-in
 *  - www.youtube.com            react-youtube loads /iframe_api; embeds are youtube.com/embed
 *  - connect.facebook.net       Facebook JS SDK (src/lib/facebookSdk.ts)
 *  - *.googleapis.com           Firestore, Identity Toolkit, Secure Token, Picker content
 *  - *.facebook.com             Facebook SDK network calls
 *  - docs/drive.google.com      Picker frame; Drive /preview iframe for unsupported documents
 *  - player.vimeo.com           Vimeo embeds (video-platforms/providers.ts)
 *  - blob:                      docx-preview images/fonts, PDFium worker, video blobs
 * 'unsafe-inline' is needed for Next.js inline bootstrap scripts (no nonce middleware yet).
 * 'unsafe-eval' is added in development only (React refresh).
 */
const csp = [
  "default-src 'self'",
  [
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    isDev ? "'unsafe-eval'" : "",
    "https://apis.google.com https://www.gstatic.com https://accounts.google.com",
    "https://www.youtube.com https://connect.facebook.net",
  ].filter(Boolean).join(" "),
  "style-src 'self' 'unsafe-inline'",
  [
    "img-src 'self' data: blob:",
    "https://*.googleusercontent.com https://*.gstatic.com",
    "https://i.ytimg.com https://img.youtube.com",
    "https://*.fbcdn.net https://platform-lookaside.fbsbx.com",
  ].join(" "),
  // next/font self-hosts Google fonts at build time; blob: is for fonts embedded in .docx files.
  "font-src 'self' data: blob:",
  [
    "connect-src 'self' https://*.googleapis.com https://*.facebook.com",
    isDev ? "ws://localhost:* http://localhost:*" : "",
  ].filter(Boolean).join(" "),
  "media-src 'self' blob:",
  [
    "frame-src 'self' https://accounts.google.com https://content.googleapis.com",
    "https://docs.google.com https://drive.google.com",
    "https://www.youtube.com https://www.youtube-nocookie.com",
    "https://www.facebook.com https://web.facebook.com https://player.vimeo.com",
    "https://*.firebaseapp.com",
    authDomainOrigin,
  ].filter(Boolean).join(" "),
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Browsers ignore frame-ancestors in report-only policies (and log a console warning), so it is only
  // added when enforcing. X-Frame-Options: SAMEORIGIN below already protects against framing meanwhile.
  ...(enforceCsp ? ["frame-ancestors 'self'"] : []),
].join("; ");

const cspHeaderName = enforceCsp ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";

// Version of the installed PDF engine. PdfReader appends it to the wasm URL (?v=...) so the one-year
// immutable cache below can never serve an engine file that no longer matches the library.
const pdfiumVersion = (() => {
  try {
    return require("./scripts/pdfiumWasm.cjs").locate()?.version || "";
  } catch {
    return "";
  }
})();

const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_PDFIUM_WASM_VERSION: pdfiumVersion,
  },
  images: {
    // Keep this allowlist narrow to the specific thumbnail hosts the app actually uses.
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "img.youtube.com" },
      { protocol: "https", hostname: "*.fbcdn.net" },
      { protocol: "https", hostname: "platform-lookaside.fbsbx.com" },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: cspHeaderName, value: csp },
          // Deliberately NO Cross-Origin-Opener-Policy: it can break the Google sign-in popup.
          // If you add one later, it must be "same-origin-allow-popups".
        ],
      },
      {
        // Self-hosted PDFium (loaded by PdfReader through an ABSOLUTE wasmUrl, because the engine worker is a
        // blob: worker where relative URLs fail). The file name is not content-hashed, so PdfReader adds
        // ?v=<engine version>, and scripts/syncPdfiumWasm.cjs keeps public/wasm/pdfium.wasm equal to the
        // installed package before every dev start and build (see docs/deploy.md).
        source: "/wasm/:path*",
        headers: [
          { key: "Content-Type", value: "application/wasm" },
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
  // This app runs on the standard Next.js server runtime for its hosting platform, so no
  // special output target or platform-specific override is required here.
};

module.exports = nextConfig;
