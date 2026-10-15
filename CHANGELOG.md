# Changelog

## 1.3.1

- **Linking a note to a note now needs Alt or Ctrl** (Option or Cmd on a Mac)
  held as you drop, so a note passed over on the way is never linked by
  accident. Without the key the badge says which key to hold; pressing it mid-drag
  switches at once. Drops on tags, values, folders and project notes are
  unchanged, and on touch no key is needed.
- Dropping a note on another note no longer chases it around: the note you
  carry stops pushing others away, whatever is near the pointer holds still
  while you drag (the rest of the graph keeps moving), and a drop target is
  caught from a little further away.

## 1.3.0

- **Details panel**: click a tag or value to see how many notes have it and what
  share of the base that is, which folders it is used in, the values it is most
  often used with, its notes (each with its other tags), and look-alike values
  such as `#recipes`/`#recipe` with a Merge button. Rename, New note and Hide
  are there too.
- **Overview**: the ⓘ button with nothing selected shows how well each property
  covers the base (with a button that lights the notes missing it), the most
  used values, look-alike pairs, rare hidden values and loose notes.
- **Note details** (right-click → Details): a note's values, links in and out,
  and the notes most like it, weighing rare shared tags above common ones.
- **Search lists results** as you type — values first — with arrow keys and
  Enter to fly to one.
- **Motion**: the graph blooms in, hubs first; a focus spreads outwards; hovered
  nodes and drop targets swell; a drop previews the links it will make (for a
  merge, every note of the carried tag) and ripples when it lands; nodes an edit
  adds pop in and removed ones shrink away. All of it stays off with *Animate
  the layout* off or the system's reduced-motion setting.
- Hub names sit on a plate so they read over the lines, and move above their hub
  when below would sit on another hub; a focused hub fills in.
- **Recency**: a value's details say when it was last edited (and in which note)
  and how many of its notes changed in the last 30 days; its notes can be sorted
  by name or by most recent. Note details and tooltips show when a note was edited.
- The details panel never covers what it describes: the view glides the focused
  node and its neighbours into the open space.
- Keys on the graph: `/` search, `i` details, `f` fit, `+`/`-` zoom; arrow keys
  walk the graph — left/right through the values by size, up/down through the
  focused node's neighbours — showing each one's details.
- The status line also counts links.
- On a phone the details panel is a sheet along the bottom, kept above
  Obsidian's navigation bar; long-press a note and choose **Details**.

## 1.2.0

- **Move folders by dragging**: with the new setting on (it is off by default),
  drop a folder hub on another folder hub to move the folder, with everything in
  it, into the other one. It asks first when *Confirm before moving files* is on,
  and Undo puts the folder back. A folder cannot be dropped into itself or one of
  its subfolders.

## 1.1.0

- **Graph settings**: a gear button opens the controls of Obsidian's graph
  view — filters (each hub property, orphans, rare values), display (arrows,
  text fade threshold, node size, link thickness) and forces (center, repel,
  link force, link distance). Changes apply live and are saved with the view.
- Hovering a node now fades its connections in and the rest out, instead of
  switching at once. Note names also fade in as you zoom, instead of popping.
- Hover a legend row to preview its notes on the graph; double-click it to zoom
  to them.
- Double-clicking a tag keeps it highlighted after zooming (it used to end up
  unhighlighted).
- Tooltips say what a click does, for as long as the editing hint is shown.
- "Lay out again" moved from the toolbar into the graph settings; it is still in
  the right-click menu.

## 1.0.3

- Code clean-up flagged by the directory review (no change in behaviour).

## 1.0.2

- Settings appear in Obsidian's settings search on 1.13 and later.
- Graph redraws use the window they are drawn in, so the view also works in a pop-out window.
- Stricter types around frontmatter edits (no change in behaviour).

## 1.0.1

- The plugin description no longer starts with the plugin name, as the community directory asks.

## 1.0.0

First release.

- A **Tag graph** view for Bases: notes are drawn around hubs for the tags,
  folders or properties they share — up to four hub properties per view.
- **Drag to tag**: drop a note on a tag or value to add it, on a folder to move
  the note, on a project note to link it; drop a tag on another to merge them.
  Rename a tag across the base (frontmatter and `#tags` in the text), create a
  note with a value, or remove one from a note from the right-click menus. Every
  edit can be undone.
- Hide tags used by too few notes, split tags by folder, toggle tags and
  properties from the legend, and tell note, heading, block, property and embed
  links apart.
- Search that highlights instead of hiding, a seeded layout that opens the same
  way every time, and a freeze button.
- Touch support: pinch to zoom, tap to preview, tap again to open, long-press
  for the menu.
- English and Korean.
