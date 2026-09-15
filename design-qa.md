# Download progress component design QA — 2026-09-15

final result: passed

Scope: selected option 1's download component, not the invented surrounding app navigation in the generated image. Existing ChordV page structure is intentionally preserved. Mobile adaptation is statically checked, not visually certified.

Reference: `/Users/a1234/.codex/generated_images/01a09b84-4e5a-7750-bb9e-e95498485773/exec-cc182a54-8b94-4824-adb0-6c3419ac560c.png`.
Implementation: `http://127.0.0.1:5199/?download-preview`.
Capture: `/tmp/chordv-progress-qa/implemented.png`.

The source image and implementation screenshot were displayed together in the same comparison tool output at the 79% / 14.8 MB / 18.8 MB state. Comparison is component-scoped: source mock is a larger raster rendering, implementation is a natural 400 CSS px panel at the browser's current viewport. The unrelated mock dashboard is not used to judge fidelity.

- Typography: compact Chinese title, regular percentage, smaller secondary bytes and actions preserve the reference hierarchy. Platform font rasterization differs; P3 only.
- Spacing/layout: bottom-right anchoring, 20px clearance, 400px maximum width, three-row hierarchy, thin progress bar, details/cancel alignment match the selected component. Long filenames stay in expandable details.
- Colors: opaque white panel, cyan indicator, blue-gray secondary text, hairline border and restrained shadow; no translucent full-width alert.
- Assets: existing Tabler download/check/chevron icons; no generated raster assets or mock dashboard installed in production.
- Copy: Xray title, byte amounts, 79%, 详情 and 取消 match. Stage-specific text uses real states; no invented speed/ETA.
- Interaction: preview showed progressing byte updates; details expansion exposed filename; verification changed title while preserving download 100%; cancellation replaced action with 重新下载. Final tab restored to collapsed 79% state and kept open.
- Accessibility: details button exposes expanded/collapsed state; download progress exposes actual numeric fraction; unknown totals do not expose a fabricated percentage. Keyboard focus styles are present.
- Production isolation: DEV-gated lazy imports; production bundle search found no preview route, debug component or simulation labels.

No actionable P0/P1/P2 visual differences found in the selected component. No production download was triggered in this preview. Real Windows/native download end-to-end behavior and small-screen screenshots were not executed.
