# Changelog

## 1.7.0

- **Notes by folder** in the details panel: next to *Name* and *Recent*, a
  *Folder* order lists a value's notes under one heading per folder, folders in
  name order with the vault root last, each with its count, the colour of its
  top-level folder and a fold arrow. Long lists (over 30 notes) start folded.
  The order you pick is remembered. Thanks to ddoter on the Obsidian forum for
  the idea.
- **A blank tab is explained.** With the Bases core plugin turned off, *Create a
  base with a tag graph* made the file and opened an empty tab with no word of
  why. It now says that Bases is off and where to turn it on, and so does
  Tag Graph itself when it starts with Bases off. Turning Bases on afterwards
  no longer needs a restart: the graph registers itself the next time a base
  is opened, where before every base read "unknown view type".
- **A first-start hint.** Tag Graph lives inside Bases and has no icon of its
  own, so a fresh install showed only its settings tab. On the first start a
  notice now names the two ways to open a graph. Shown once, and not to anyone
  updating.

## 1.6.0

- **Remove and delete from the keyboard** (#3): two new commands act on the
  node you clicked (the one the details panel shows). *Remove the selected tag
  or property from all notes* does what *Remove from all notes* does on a tag
  or value hub, including the sub-hub case, and can be undone from the notice.
  *Delete the selected note or folder* does what *Delete note* or *Delete
  folder* does and always asks first. Neither has a default hotkey; bind them
  in Settings → Hotkeys, for example to <kbd>Delete</kbd>. They do nothing while
  you are typing in the graph's search box. Thanks @dleeftink for the request.

## 1.5.3

- The settings tab no longer carries the hand-drawn version kept for Obsidian
  before 1.13.0 (`display()`, deprecated in 1.13.0). Since 1.5.2 requires 1.13.0,
  Obsidian draws the tab from the declared settings, as it already did. Nothing
  changes on screen.

## 1.5.2

- **Requires Obsidian 1.13.0.** Tag Graph's settings appear in Obsidian's settings
  search, which uses APIs added in 1.13.0, while the manifest still said 1.10.2.
  The directory's automated review flagged that. On older Obsidian versions
  1.5.1 stays installed and keeps working.
- Confirmation dialogs for deleting notes or folders use the new destructive
  button style.

## 1.5.1

- No changes to the plugin. A new release so the community directory runs its
  automated review again: 1.5.0 stayed "Not scanned" and dropped out of the
  plugin list.

## 1.5.0

- **Simplified Chinese (中文)**: the whole interface — graph, legend, details
  panel, menus, notices, settings and commands — is now in Chinese too, using
  Obsidian's own terms (笔记, 标签, 属性, 仓库, 反向链接).
- **Language setting**: *Follow Obsidian* (the default), English, 한국어 or
  中文. Obsidian set to Chinese (simplified or traditional) picks Chinese. A
  change applies to open graphs and to the settings at once; command names and
  the view's name in the Bases menu follow after Obsidian restarts.
- *Create a base with a tag graph* names the new base and its view in the
  interface language.

## 1.4.0

- **Folder trees** (#2): with the new view option *Link folders to their parent
  folder*, each folder hub is joined to the hub of the folder it sits in, so a
  folder hierarchy is drawn as a tree, one per top-level folder. A parent with
  no notes of its own is drawn too, so the tree has no gaps. *Show folder names,
  not paths* labels folder hubs `Acme` instead of `Work/Clients/Acme`.
- **Create and rename from the graph** (#4): right-click empty space for a new
  note, a folder hub for a new note in that folder, a note to rename it, a
  folder hub to rename the folder. Links are updated as your settings say, and
  a rename can be undone from its notice.
- **Remove and delete from the graph** (#3): right-click a tag or value for
  *Remove from all notes* (on a sub-hub, from the notes in its folder only),
  which can be undone. A note in a folder gets *Move to vault root*, which takes
  it off its folder hub. *Delete note* and *Delete folder* send them to the
  trash your *Deleted files* setting chooses, and always ask first.

## 1.3.2

- Code clean-up flagged by the directory review: "edited 3 days ago" is now
  worded by the plugin itself, and a few constructs the review reads as untyped
  were rewritten (no change in behaviour).

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
