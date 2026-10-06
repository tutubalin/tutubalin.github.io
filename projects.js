/* ============================================================================
   SITE & PROJECT LIST — this is the ONLY file you need to edit for content.

   Add a new project in 2 steps:
     1. Create a folder, e.g.  my-project/index.html
     2. Copy one block below, fill in your values.

   Fields
   ------
   name        required  Title shown on the tile.
   description optional  One line shown under the title.
   url         required  "my-project/" for a folder on this site,
                           or "https://..." for an external link
                           (external links open in a new tab automatically).
   icon        optional  An emoji ("🚀") OR a path to an image
                           ("assets/icons/rocket.svg" or a full https:// URL).
   color       optional  Hex color used for the tile glow, e.g. "#6366f1".
                           Omit it and a color is picked automatically.
   ========================================================================== */

const SITE = {
  title: "My Projects",
  tagline: "A few things I've built — each one lives in its own folder.",
  footer: "Hosted on GitHub Pages",
};

const PROJECTS = [

  {
    name: "A number of Pi",
    description: "Script that calculate Pi and looks like Pi at the same time",
    url: "pi/",
    icon: "𝜋",              // or "assets/icons/my-icon.svg"
    color: "#10b981",
  },

  {
    name: "Flux.2 tutorial",
    description: "AI agent wrote (with my help) a nice guide how Flux.2 actually works inside",
    url: "flux/",
    icon: "🖼️",              // or "assets/icons/my-icon.svg"
    color: "#e9c826",
  },  

  // ── Add your projects below ──────────────────────────────────────────────
  // {
  //   name: "My Project",
  //   description: "What it does, in one short line.",
  //   url: "my-project/",
  //   icon: "🎨",              // or "assets/icons/my-icon.svg"
  //   color: "#10b981",
  // },
];
