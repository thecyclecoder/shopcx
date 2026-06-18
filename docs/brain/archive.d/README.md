# archive.d/ — per-spec archive entries (generated source for archive.md)

One file per verified/retired spec: `{slug}.md`, containing **exactly one** archive entry line in the shape

```
- **<Title>** · verified <YYYY-MM-DD> · → [[lifecycles/<brain-home-slug>]]
```

`../archive.md`'s **## Index** is **generated** from this directory by `scripts/brain-index.mjs`
(`npm run brain:index`) — newest first, tie-broken by slug. Never hand-edit the list in `archive.md`.

Why: parallel fold-builds used to collide on `archive.md`'s top line (every fold edited the same row →
mutually `Dirty` PRs). Writing a distinct per-spec file here means two folds never touch the same line.
A batch fold-build writes one file per spec it retires, then runs `brain:index`.

See [[../specs/fold-build-batching]] · [[../project-management]].
