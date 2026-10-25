# Additive implementation plan: isolated desktop widget instances

This branch deliberately leaves the existing widget provider, default cache, profile settings and legacy bridge untouched.

## New architecture boundary

A desktop instance is not a template/profile. Each successfully pinned Android widget gets a stable appWidgetId and an independent snapshot of the chosen template, CSS, character binding, size and content. Templates are source material only: creating an instance copies the template into the instance snapshot. Normal edits and refreshes target one instance; bulk refresh is explicit.

## Migration safety

- Do not delete or rewrite legacy `default` HTML/PNG/preferences while introducing this path.
- Existing widgets continue to use the current provider path.
- New instances must be opt-in through a new UI entry point and a separate bridge/action namespace.
- Bind only after Android confirms the new appWidgetId. Pending requests need unique request IDs; do not infer the new widget from the most recently created profile.
- If a new instance cannot bind or render, preserve its record and show a diagnostic error instead of silently switching it to `default`.
- Keep the instance registry separate from legacy profile storage. Migration/import should be a later explicit operation, after device verification.

## Validation gate

Test two or more instances with different characters, templates, sizes and content; edit/refresh/delete each independently; force-stop and reopen; trigger native periodic update; verify pending pin callbacks cannot cross-bind. Existing widgets must remain unchanged throughout.

## Chat history search acceptance criteria

Search across the currently hydrated local chat database; filter by date range and message/media type (image, video, audio, file/attachment, text and other rich cards); show session, timestamp and a useful preview; selecting a result opens the corresponding session and scrolls to the exact message. Search must be read-only and must not rewrite chat records or migrate the database.
