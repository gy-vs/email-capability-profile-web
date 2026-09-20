# Email Rendering Lab

Local workbench for render previews with **versioned client capability profiles** and a
deterministic CSS/HTML degradation pipeline.

Run `npm install`, then `npm run dev`.

## What it does

1. Define a client capability config (`src/shared/types.ts` → `CapabilityConfig`):
   - unsupported CSS properties and value patterns (with profile fallback values)
   - media-query support, max nesting depth, supported features
   - supported image formats
   - dark-mode mechanisms (`prefers-color-scheme`, `color-scheme` meta, attribute hooks)
2. Run a template through `POST /api/transform` bound to an **explicit profile revision**.
3. The server parses the template into a node tree (stable `nid`s), applies degradations in a
   fixed phase order, and returns the transformed HTML plus one explanation per degradation.
4. The UI shows original vs transformed side by side (code or rendered); selecting an
   explanation highlights the corresponding node (and related nodes, e.g. the earlier
   declaration that a value fell back to).

### Degradation phases (fixed order in `src/server/transform.ts`)

| Phase | Rule |
| --- | --- |
| 10 | `@media (prefers-color-scheme)` removed when dark mode unsupported |
| 20 | media queries / unsupported media features removed |
| 30 | nested media beyond `media.maxDepth` flattened (contents lifted, condition dropped) |
| 40 | dark-mode attribute-hook selectors (`[data-ogsc]` …) removed |
| 50 | `<meta name="color-scheme" content="...dark">` removed |
| 60 | `<picture>` candidate negotiation (unsupported sources dropped; `<picture>` unwrapped to its `<img>` when none match) |
| 70 | unsupported **values**: nearest earlier supported author declaration wins, else profile fallback, else removal |
| 80 | unsupported **properties** removed (rules and inline styles) |
| 90 | cascade conflict detection: when the winning declaration is removed, the resurging earlier value is flagged |

Explanations are sorted by `(phase, nodeId)` and every run on the same input produces the
same output regardless of rule/object iteration order.

### Revisions and snapshots

- Profiles are saved with optimistic-lock revisions (`PUT` requires the current revision).
- Every save stores an immutable config snapshot; revision snapshots are never deleted.
- Previews bind template content + exact profile revision. Historical previews replay from
  the stored snapshot even after the live profile is edited or deleted (UI marks them
  `snapshot`).

## API

- `GET/PUT /api/templates/:id` — template content with revision
- `GET/POST/PUT/DELETE /api/profiles…`, `GET /api/profiles/:id/revisions/:revision`
- `POST /api/transform` — `{templateId, profileId, profileRevision, useDraft?, content?}`
- `GET /api/previews`, `GET /api/previews/:id`

## Tests

`npm test` — covers unsupported-property removal, value-level fallbacks, picture
candidates, nested media rules, cascade conflicts, deterministic ordering, node identity,
revision conflicts, config updates and post-deletion snapshot replay.
