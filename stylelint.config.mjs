/**
 * Stylelint for src/browser: stylelint-config-standard, fitted to the
 * stylesheets' own deliberate conventions rather than the other way round, plus
 * the one rule a stylesheet review cannot hold by eye — every colour comes from
 * a `--lsr-*` token, and only `css/tokens.css` writes a colour literal.
 */
const RAW_COLOR_FUNCTIONS = [
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
];

export default {
  extends: ["stylelint-config-standard"],
  plugins: ["stylelint-declaration-strict-value"],
  // A disable is a debt with a reason, retired once the rule no longer fires.
  reportDescriptionlessDisables: true,
  reportNeedlessDisables: true,
  rules: {
    // tokens.css writes oklch() as numbers throughout (`oklch(0.55 0.17 262)`).
    "hue-degree-notation": "number",
    "lightness-notation": "number",
    "alpha-value-notation": "number",
    // test/browser/stylesheet-boundary.test.ts reads chrome.css's imports by their exact `@import "./css/…";` shape.
    "import-notation": "string",
    // Every breakpoint is written `(max-width: …)`; one notation, the established one.
    "media-feature-range-notation": "prefix",
    // A why-comment sits directly on the declaration it explains; a blank line would detach it.
    "comment-empty-line-before": null,
    // Flags source order, not a conflict: context overrides deliberately precede the base rule they refine.
    "no-descending-specificity": null,
    // Paint properties take a token, a function of tokens or a keyword. Not box-shadow: its geometry is no token.
    "scale-unlimited/declaration-strict-value": [
      ["/color$/", "fill", "stroke"],
      {
        expandShorthand: true,
        ignoreValues: ["/^(transparent|currentcolor|inherit|initial|unset|none)$/i"],
      },
    ],
    // The plugin passes any function and skips custom properties: literals inside `color-mix()` are caught here.
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": RAW_COLOR_FUNCTIONS,
  },
  overrides: [
    {
      // The palette itself: the one file whose job is writing colour literals.
      files: ["src/browser/css/tokens.css"],
      rules: {
        "scale-unlimited/declaration-strict-value": null,
        "color-no-hex": null,
        "color-named": null,
        "function-disallowed-list": null,
      },
    },
  ],
};
