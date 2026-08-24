/**
 * What does this browser look like to a detector?
 *
 * Connects the way the farm does — a fresh BrowserContext over CDP — and reads
 * back the signals sites actually test. The point is to measure before
 * changing anything: §6 warns that clumsy patching is itself detectable, and
 * you cannot keep a patch minimal without knowing which signals are really
 * wrong.
 *
 *   node spike/fingerprint.ts                    # against BROWSER_URL
 *   node spike/fingerprint.ts --url http://…     # explicit endpoint
 *
 * Prints one JSON object. Compare runs before and after a change.
 */
import puppeteer from "puppeteer-core";

const idx = process.argv.indexOf("--url");
const browserURL =
  idx > -1 ? process.argv[idx + 1]! : (process.env.BROWSER_URL ?? "http://127.0.0.1:9222");

const browser = await puppeteer.connect({ browserURL, defaultViewport: null });
const context = await browser.createBrowserContext();
const page = await context.newPage();

// A real page, not about:blank: several signals (window size, visibility,
// media queries) only mean anything once a document has actually laid out.
await page.setContent("<!doctype html><title>probe</title><p>probe</p>", {
  waitUntil: "domcontentloaded",
});

const report = await page.evaluate(() => {
  const nav = navigator as Navigator & {
    webdriver?: boolean;
    deviceMemory?: number;
    userAgentData?: { brands?: unknown; platform?: string; mobile?: boolean };
  };

  // WebGL vendor/renderer is the single loudest server-side tell: software
  // rendering names the rasteriser outright.
  let webgl: Record<string, unknown> = { available: false };
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      webgl = {
        available: true,
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      };
    }
  } catch (e) {
    webgl = { available: false, error: String(e) };
  }

  // A patched function whose toString no longer reads as native is a stronger
  // signal than whatever the patch was hiding.
  const nativeish = (fn: unknown) =>
    typeof fn === "function" ? /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn)) : null;

  return {
    webdriver: nav.webdriver ?? null,
    userAgent: nav.userAgent,
    headlessInUA: /headless/i.test(nav.userAgent),
    platform: nav.platform,
    vendor: nav.vendor,
    languages: nav.languages,
    language: nav.language,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory ?? null,
    maxTouchPoints: nav.maxTouchPoints,
    pdfViewerEnabled: (nav as { pdfViewerEnabled?: boolean }).pdfViewerEnabled ?? null,
    plugins: nav.plugins.length,
    mimeTypes: nav.mimeTypes.length,
    userAgentData: nav.userAgentData
      ? { platform: nav.userAgentData.platform, mobile: nav.userAgentData.mobile }
      : null,
    chromeRuntime: typeof (window as { chrome?: { runtime?: unknown } }).chrome !== "undefined",
    notificationPermission: typeof Notification !== "undefined" ? Notification.permission : null,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
    },
    window: {
      innerWidth: innerWidth,
      innerHeight: innerHeight,
      // 0 in headless: there is no browser frame around the viewport.
      outerWidth: outerWidth,
      outerHeight: outerHeight,
      devicePixelRatio: devicePixelRatio,
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    media: {
      hover: matchMedia("(hover: hover)").matches,
      finePointer: matchMedia("(pointer: fine)").matches,
      prefersReducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    },
    webgl,
    nativeToString: {
      webdriverGetter: nativeish(
        Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver")?.get
      ),
      permissionsQuery:
        typeof navigator.permissions?.query === "function"
          ? nativeish(navigator.permissions.query)
          : null,
    },
  };
});

await page.close();
await context.close();
browser.disconnect();

console.log(JSON.stringify(report, null, 2));
