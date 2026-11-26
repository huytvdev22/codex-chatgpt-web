---
name: "gemini-image"
description: "Generate or edit raster images via Gemini Web when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or covers. Adapted from Codex's production imagegen skill to run natively through the local codex-chatgpt-web bridge (Node.js, zero Python or OPENAI_API_KEY required), working in both auth_mode apikey and chatgpt. Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas."
---

# Gemini Image Generation Skill (`$gemini-image`)

Generates or edits images for the current project (for example website assets, game assets, UI mockups, product mockups, wireframes, logo design, photorealistic images, or infographics) through the local Gemini Web bridge (`codex-chatgpt-web`).

## Top-level modes and rules

This skill supports two execution paths seamlessly:

- **Path A — Built-in `image_gen` tool:** Use when `image_gen` is available in your current tool catalog (e.g. `auth_mode: "chatgpt"`). Do not ask for `OPENAI_API_KEY`.
- **Path B — Local Gemini Web Node.js CLI (`scripts/gemini-image.mjs`):** Use immediately whenever built-in `image_gen` is unavailable (e.g. `auth_mode: "apikey"`), or when you need direct control over `--out` / `--ratio` / `--thread-id`. Runs purely with `node` against `127.0.0.1` — **never** ask the user for `OPENAI_API_KEY` and **never** use Python (`scripts/image_gen.py`).

CLI commands (resolve `<skill_dir>` from the skill root shown in the prompt, defaulting to `~/.codex/skills/gemini-image`):
- Generate:
  ```bash
  node "<skill_dir>/scripts/gemini-image.mjs" generate --prompt "<prompt>" [--ratio 16:9] [--out "<path.png>"] [--thread-id "<id>"]
  ```
- Edit (up to 3 `--image` inputs):
  ```bash
  node "<skill_dir>/scripts/gemini-image.mjs" edit --image "<src.png>" --prompt "<edit instruction>" [--ratio 16:9] [--out "<path.png>"] [--thread-id "<id>"]
  ```

Rules:
- If `image_gen` is unavailable in the active tool catalog, switch straight to `scripts/gemini-image.mjs` without asking the user for permission or an API key.
- **Sandbox & timeout requirement for `exec_command` (Path B):** Codex's default `workspace-write` sandbox blocks loopback network calls to `127.0.0.1` (`EPERM`). Always invoke `scripts/gemini-image.mjs` with `sandbox_permissions: "require_escalated"`, `justification: "Call local codex-chatgpt-web image bridge on 127.0.0.1"`, and `yield_time_ms: 60000` (image generation takes ~25–45s). If you ever see `EPERM` or `fetch failed`, immediately retry with `sandbox_permissions: "require_escalated"` instead of running `lsof`/`ps` inside the sandbox or stopping to ask the user.
- After `scripts/gemini-image.mjs` outputs `{ ok, path, width, height, ... }`, **always call `view_image`** on `path` so you inspect the generated/edited image directly before responding.
- Gemini Web constraints (fail-fast `400` if violated):
  - Supported aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`.
  - No native alpha transparency (`transparent_background` / `background="transparent"`), no animated `gif`, and no bitmap `mask` arguments. If an isolated subject is needed, request a clean solid neutral/white background instead.
- Save-path precedence:
  1. If the user names a destination, pass `--out` (or copy/move built-in output there).
  2. If the image is meant for the current project, save or copy it into the workspace before finishing; never leave a project-referenced asset only under `$CODEX_HOME/generated_images/...`.
  3. If preview-only, `$CODEX_HOME/generated_images/...` is fine.
- Do not overwrite an existing asset unless explicitly asked; otherwise create a sibling versioned filename (`hero-v2.png`, `icon-edited.png`).

Shared prompt guidance lives in `references/prompting.md` and `references/sample-prompts.md`.

## When to use
- Generate a new image (concept art, product shot, cover, website hero)
- Generate a new image using one or more reference images for style, composition, or mood
- Edit an existing image (lighting/weather transformations, background replacement, object swap, style transfer, compositing)
- Produce many assets or variants for one task

## When not to use
- Extending or matching an existing SVG/vector icon set, logo system, or illustration library inside the repo
- Creating simple shapes, diagrams, wireframes, or icons that are better produced directly in SVG, HTML/CSS, or canvas
- Making a small project-local asset edit when the source file already exists in an editable native format
- Any task where the user clearly wants deterministic code-native output instead of a generated bitmap

## Decision tree

Think about two separate questions:

1. **Intent:** is this a new image or an edit of an existing image?
2. **Execution strategy:** is this one asset or many distinct assets?

Intent:
- If the user wants to modify an existing image while preserving parts of it, treat the request as **edit**.
- If the user provides images only as references for style, composition, mood, or subject guidance, treat the request as **generate**.
- If the user provides no images, treat the request as **generate**.

Edit semantics:
- In Path A (`image_gen`), inspect any local file with `view_image` first so it enters conversation context before calling `image_gen`.
- In Path B (`scripts/gemini-image.mjs`), pass the local image path directly via `--image "<path>"` and pass a stable `--thread-id` to keep generation + follow-up edits in the same Gemini image conversation.
- For edits, preserve invariants aggressively and save non-destructively by default.

## Workflow
1. Choose Path A (`image_gen` if present in tool catalog) or Path B (`scripts/gemini-image.mjs` via `exec_command` otherwise).
2. Decide intent (`generate` vs `edit`) and whether output belongs in the workspace or `$CODEX_HOME/generated_images/`.
3. Collect prompt, exact in-image text (verbatim), desired aspect ratio (`1:1`, `16:9`, `9:16`, `4:3`, `3:4`), constraints/avoid list, and input images (role-labeled).
4. Shape the prompt per **Prompt augmentation** & **Specificity policy** below (include `Preferred aspect ratio: <ratio>` or pass `--ratio`).
5. Execute Path A or Path B (`node "<skill_dir>/scripts/gemini-image.mjs" ...`).
6. In Path B, immediately inspect the saved PNG with **`view_image`** and validate subject, style, aspect ratio, text accuracy, and invariants.
7. If adjustments are needed, iterate with a single targeted `edit` change keeping invariants explicit.
8. Report the final saved path(s) (with clickable Markdown link `[filename](path)`), concise visual verification summary, and aspect ratio.

## Prompt augmentation

Reformat user prompts into a structured, production-oriented spec. Make the user's goal clearer and more actionable, but do not blindly add detail.

Treat this as prompt-shaping guidance, not a closed schema. Use only the lines that help, and add a short extra labeled line when it materially improves clarity.

### Specificity policy

- If the prompt is already specific and detailed, preserve that specificity and only normalize/structure it.
- If the prompt is generic, add tasteful augmentation only when it materially improves output quality.

Allowed augmentations:
- composition, aspect ratio, or framing hints
- polish level or intended-use hints
- practical layout guidance and reasonable scene concreteness

Not allowed augmentations:
- extra characters or objects not implied by the request
- unrequested brand names, slogans, palettes, or arbitrary left/right placement

## Use-case taxonomy (exact slugs)

Generate:
- `photorealistic-natural` — candid/editorial lifestyle scenes with real texture and natural lighting.
- `product-mockup` — product/packaging shots, catalog imagery, merch concepts.
- `ui-mockup` — app/web interface mockups and wireframes; specify fidelity.
- `infographic-diagram` — diagrams/infographics with structured layout and text.
- `scientific-educational` — classroom explainers, scientific diagrams with required labels.
- `ads-marketing` — campaign creatives with audience, brand position, scene, and exact tagline.
- `productivity-visual` — slide, chart, workflow, and business visuals.
- `logo-brand` — logo/mark exploration, vector-friendly.
- `illustration-story` — comics, children’s book art, narrative scenes.
- `stylized-concept` — style-driven concept art, 3D/stylized renders.
- `historical-scene` — period-accurate scenes.

Edit:
- `text-localization` — translate/replace in-image text, preserve layout.
- `identity-preserve` — try-on, person-in-scene; lock face/body/pose.
- `precise-object-edit` — remove/replace a specific element.
- `lighting-weather` — time-of-day/season/atmosphere changes only.
- `background-replacement` — replace backdrop cleanly on neutral/custom background while keeping subject edges unchanged.
- `style-transfer` — apply reference style while changing subject/scene.
- `compositing` — multi-image insert/merge with matched lighting/perspective.
- `sketch-to-render` — drawing/line art to photoreal render.

## Shared prompt schema

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; aspect ratio>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Augmentation rules:
- Keep it concise; add only details needed to improve quality materially.
- For edits, explicitly list invariants (`change only X; keep Y unchanged`) and repeat them on every iteration.

## Examples

### Generation example (hero image)
```text
Use case: product-mockup
Asset type: landing page hero
Primary request: a minimal hero image of a ceramic coffee mug
Style/medium: clean product photography
Composition/framing: 16:9 wide composition with usable negative space for page copy
Lighting/mood: soft studio lighting
Constraints: no logos, no text, no watermark
```

### Edit example (invariants)
```text
Use case: precise-object-edit
Asset type: product photo background replacement
Primary request: replace only the background with a warm sunset gradient
Constraints: change only the background; keep the product and its edges unchanged; no text; no watermark
```

## Prompting best practices
- Structure prompt as scene/backdrop -> subject -> details -> constraints.
- Include intended use (ad, UI mock, infographic) and camera/composition language for photorealism.
- Quote exact text and specify typography + placement; spell uncommon words if accuracy matters.
- Reference multi-image inputs by index (`Image 1`, `Image 2`) and describe their exact roles.
- For edits, repeat invariants every iteration to prevent drift and iterate one targeted change at a time.

## Reference map
- `references/prompting.md`: shared prompting principles, specificity policy, and use-case tips.
- `references/sample-prompts.md`: copy/paste prompt recipes across generate and edit categories.
- `scripts/gemini-image.mjs`: Node.js CLI runner for the local Gemini Web bridge (`generate` and `edit`).
- `LICENSE.txt`: Apache-2.0 license notice (derived from OpenAI Codex `imagegen` skill).
