# Template Gallery — Shared Task Notes

## What's Done (Phase 1 + Phase 2 start)

### Template Data Architecture (Phase 1)
- `src/lib/template-registry.ts` — Template schema with rich metadata: categories, subcategories, tags, packages, accent colors, bibliography flag. 12 templates total (was 8). New: IEEE, ACM, Technical Report, Newsletter. Registry API: `getAllTemplates()`, `getTemplateById()`, `searchTemplates()`, `getTemplatesByCategory()`.
- `src/stores/template-store.ts` — Zustand store for gallery state: search query, category filter, template selection, preview state. `computeFiltered()` handles combined search+category filtering.

### Visual Gallery UI (Phase 2 start)
- `src/components/template-gallery/` — New component directory:
  - `template-gallery.tsx` — Main gallery: search bar (⌘K), category sidebar + grid layout, grouped view when no filter active, empty state
  - `template-card.tsx` — Cards with CSS-based document thumbnail placeholders (9 distinct layouts: paper, slides, poster, CV, letter, book, report, newsletter, blank). Hover reveals "Preview" button
  - `category-sidebar.tsx` — Category navigation with template counts
  - `template-preview.tsx` — Dialog showing LaTeX source, package list, tags, metadata, "Use Template" CTA
  - `index.ts` — Barrel export

### Wizard Refactor
- `project-wizard.tsx` — Now uses `TemplateGallery` for step 1 instead of old inline `TemplateGrid`. Step 2 (project details) unchanged. All project creation logic preserved. Uses `template.hasBibliography` instead of hardcoded ID check.

## Next Priorities

### Phase 2 completion
- **Keyboard navigation** — Arrow keys to navigate grid, Enter to select, Tab between sections
- **Animations** — Consider adding `framer-motion` (not currently installed) for card entrance animations and page transitions
- **Responsive grid** — Test and tune grid breakpoints for various window sizes

### Phase 3: Template Preview System
- **PDF thumbnail generation** — Compile templates to PDF, render first page as image using pdfjs-dist (already a dependency). Store as cached images. Replace CSS placeholders with actual rendered thumbnails
- **Live preview in modal** — Show rendered PDF in the preview dialog instead of just source code
- **Multi-page preview** — For templates like presentations/books
- **Side-by-side compare** — Allow comparing two templates

### Phase 4: Package Integration
- **Package browser** — Curated CTAN package list
- **Package adding** — Let users add packages before project creation
- **Compatibility checker** — Warn about conflicting packages

### Phase 5: More Templates
- **Springer, APA, MLA, Chicago** style templates
- **User template library** — Save customized templates
- **Template import** — From .tex files or Overleaf

## Technical Notes
- No `framer-motion` installed — animations use Tailwind CSS `tw-animate-css`. Install if needed for gallery transitions
- `line-clamp-2` used in template-card.tsx — may need `@tailwindcss/line-clamp` if not natively supported (TW4 may include it)
- Template IDs changed: `paper` → `paper-standard`, `cv` → `cv-modern`, etc. Old IDs no longer exist
- `react-pdf` and `pdfjs-dist` already installed — ready for thumbnail generation work
