# Deduplicate and generalise

Two goals, one pass.

## 1. Close the 96 duplicate concepts

See `DUPLICATE_CONCEPTS.md`. Each finding names the sites, what breaks, and the
single home it should collapse into. Those "single home" columns are the design;
follow them unless reading the code shows a better one, and say so if you deviate.

## 2. Make this work for anyone

This repo is going to be open source. Right now it is one person's box:

- Four ventures are seeded straight into a migration (`server/src/db.ts:2566`).
- Comments cite `workdash` (the owner's previous system) and the owner's own
  domains as design rationale.
- Some defaults assume the owner's registrars, hosts and mailboxes.

Target: **one owner per install, nothing of theirs baked in.** Not multi-tenant.
A stranger clones this, runs setup, connects their own plugins, and gets an empty
box that works. The security model stays exactly as it is: one owner, one box.

## Hard rules

1. **Reduce code.** Every wave reports lines added vs removed. A fix that only
   adds a shared module without deleting the copies it replaces is not done.
2. **The owner's existing database must keep working.** They are running this.
   Seeded rows become first-run-only defaults that existing rows override. Table
   merges carry rows across in the migration. Never drop a table holding data
   without moving it first.
3. **New migrations use the 400+ range**, named `NNN_short_name`, in the owning
   area's own `migrations.ts`. Never edit an existing migration -- it has already
   run on the owner's box.
4. **Stay inside the files you were assigned.** Sixteen agents collided last time
   by editing shared files. If a fix needs a file outside your set, write it in
   your report instead of editing it.
5. **Design rationale in comments is an asset -- keep it.** Rewrite the parts
   that name the owner's ventures or private infrastructure so a stranger can
   read them. "workdash counted this wrong and it cost $415" becomes the lesson
   without the name where the name adds nothing; keep it where it is the evidence.
6. `npm run check` must pass (server + client tests, build, lint, catalog, strict).
