import { describe, expect, test } from "vitest";
import {
  MDI_ICON_OPTIONS,
  MDI_PATHS,
  extractIconDirective,
  getIconPath,
  hasIcon,
  normalizeIconSlug,
  resolveIcon,
} from "./mdi-paths";

describe("MDI_PATHS", () => {
  test("carries a substantial curated set", () => {
    expect(Object.keys(MDI_PATHS).length).toBeGreaterThanOrEqual(150);
  });

  test("every path is non-empty and starts with a move command", () => {
    for (const [slug, path] of Object.entries(MDI_PATHS)) {
      expect(path.length, slug).toBeGreaterThan(10);
      // The prior assertion guarantees path is non-empty, so trimStart()[0] exists.
      expect(path.trimStart()[0]!.toLowerCase(), slug).toBe("m");
    }
  });

  test("no path references an external resource", () => {
    for (const [slug, path] of Object.entries(MDI_PATHS)) {
      expect(path, slug).not.toMatch(/url\(|href|<|>/);
    }
  });

  test("carries every slug the CLI reference engine can emit", () => {
    // Parity with secondbrain/scripts/lib/mdi-icons.js keeps a web-generated
    // label visually identical to a CLI-generated one.
    const cliSlugs = [
      "archive-outline",
      "package-variant",
      "package-variant-closed",
      "toolbox",
      "folder",
      "screw-machine-flat-top",
      "screw-round-top",
      "nut",
      "wrench",
      "hammer",
      "tools",
      "tape-measure",
      "cable-data",
      "power-plug",
      "battery",
      "chip",
      "memory",
      "harddisk",
      "server",
      "router-wireless",
      "soldering-iron",
      "printer-3d",
      "car-wrench",
      "medical-bag",
      "pill",
      "file-document-outline",
      "speaker",
      "lightbulb",
      "silverware-fork-knife",
      "spray-bottle",
      "home",
    ];
    for (const slug of cliSlugs) expect(MDI_PATHS, slug).toHaveProperty(slug);
  });
});

describe("MDI_ICON_OPTIONS", () => {
  test("every option resolves to a real path", () => {
    expect(MDI_ICON_OPTIONS.length).toBeGreaterThan(100);
    for (const option of MDI_ICON_OPTIONS) {
      expect(MDI_PATHS, option.slug).toHaveProperty(option.slug);
      expect(option.label).not.toContain("-");
      expect(option.group.length).toBeGreaterThan(0);
    }
  });

  test("contains no duplicate slugs", () => {
    const slugs = MDI_ICON_OPTIONS.map(option => option.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("normalizeIconSlug", () => {
  test.each([
    ["mdi:wrench", "wrench"],
    ["mdi-wrench", "wrench"],
    ["  WRENCH  ", "wrench"],
    ["wrench", "wrench"],
    ["", ""],
    [null, ""],
    [undefined, ""],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeIconSlug(input as string)).toBe(expected);
  });
});

describe("extractIconDirective", () => {
  test("reads an icon directive from a description", () => {
    expect(extractIconDirective("Spare parts bin\nicon: mdi:nut\n")).toBe("nut");
  });

  test("accepts a bare slug without the mdi prefix", () => {
    expect(extractIconDirective("icon: server")).toBe("server");
  });

  test("returns null when no directive is present", () => {
    expect(extractIconDirective("Just a description")).toBeNull();
    expect(extractIconDirective("")).toBeNull();
    expect(extractIconDirective(null)).toBeNull();
  });

  test("ignores an icon word that is not a directive", () => {
    expect(extractIconDirective("This bin holds icons and stickers")).toBeNull();
  });
});

describe("resolveIcon", () => {
  test("an explicit override wins over everything else", () => {
    expect(resolveIcon("M3 Screws", "icon: mdi:nut", "mdi:server", true)).toBe("server");
  });

  test("an unknown explicit override falls through to the next rule", () => {
    expect(resolveIcon("M3 Screws", "", "mdi:not-a-real-icon", true)).toBe("screw-machine-flat-top");
  });

  test("a description directive beats the keyword heuristic", () => {
    expect(resolveIcon("Cable Bin", "icon: mdi:server", null, true)).toBe("server");
  });

  test.each([
    ["M3 Screws", "screw-machine-flat-top"],
    ["Spare Nuts and Washers", "nut"],
    ["Ratchet and Socket Set", "wrench"],
    ["Claw Hammer", "hammer"],
    ["HDMI Cables", "cable-data"],
    ["Cat6 Patch Leads", "ethernet-cable"],
    ["Wall Chargers", "power-plug"],
    ["18650 Cells", "battery"],
    ["Soldering Supplies", "soldering-iron"],
    ["ESP32 Dev Boards", "chip"],
    ["DDR4 SODIMM", "memory"],
    ["NVMe Drives", "harddisk"],
    ["Rack Shelf", "server"],
    ["Wireless Access Point", "router-wireless"],
    ["PETG Filament", "printer-3d"],
    ["Hotend Nozzles", "printer-3d-nozzle"],
    ["First Aid Supplies", "medical-bag"],
    ["Vitamins", "pill"],
    ["Warranty Documents", "file-document-outline"],
    ["Spare Light Bulbs", "lightbulb"],
    ["Cleaning Supplies", "spray-bottle"],
    ["Kitchen Utensils", "silverware-fork-knife"],
  ])("maps %s to %s", (name, expected) => {
    expect(resolveIcon(name, "", null, true)).toBe(expected);
  });

  // Rule order is inherited verbatim from the CLI reference engine so that a
  // label generated in the browser picks the same glyph the CLI would. Two
  // broad rules therefore win over narrower ones; the modal's icon picker is
  // the escape hatch.
  test.each([
    ["USB Chargers", "cable-data", "the cable rule claims 'usb' before the power rule runs"],
    ["First Aid Kit", "toolbox", "the toolbox rule claims 'kit' before the medical rule runs"],
  ])("%s resolves to %s (%s)", (name, expected) => {
    expect(resolveIcon(name, "", null, true)).toBe(expected);
  });

  test("falls back by entity kind when nothing matches", () => {
    expect(resolveIcon("Zzyzx", "", null, true)).toBe("archive-outline");
    expect(resolveIcon("Zzyzx", "", null, false)).toBe("package-variant");
  });

  test("every heuristic and fallback target exists in the dictionary", () => {
    const names = [
      "screws",
      "nuts",
      "nails",
      "wrench",
      "hammer",
      "screwdriver",
      "saw",
      "pliers",
      "tools",
      "toolbox",
      "tape",
      "paint",
      "ethernet",
      "cable",
      "power supply",
      "battery",
      "solder",
      "resistor",
      "chip",
      "ram",
      "ssd",
      "sd card",
      "server",
      "router",
      "camera",
      "keyboard",
      "laptop",
      "monitor",
      "phone",
      "console",
      "nozzle",
      "filament",
      "car",
      "tire",
      "first aid",
      "medicine",
      "goggles",
      "documents",
      "pens",
      "keys",
      "speakers",
      "bulbs",
      "cleaning",
      "cutlery",
      "clothing",
      "garden",
      "camping",
      "gym",
      "sewing",
      "toys",
      "baby",
      "pets",
      "home",
    ];
    for (const name of names) {
      expect(hasIcon(resolveIcon(name, "", null, true)), name).toBe(true);
    }
  });
});

describe("getIconPath", () => {
  test("returns the archive glyph for an unknown slug", () => {
    expect(getIconPath("not-a-real-icon")).toBe(MDI_PATHS["archive-outline"]);
    expect(getIconPath(null)).toBe(MDI_PATHS["archive-outline"]);
  });

  test("accepts a prefixed slug", () => {
    expect(getIconPath("mdi:server")).toBe(MDI_PATHS.server);
  });
});
