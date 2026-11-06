import type { Site, Metadata, Socials } from "@types";

export const SITE: Site = {
  NAME: "Kongara Naveen",
  EMAIL: "kongara.naveen97@gmail.com",
  NUM_POSTS_ON_HOMEPAGE: 3,
  NUM_WORKS_ON_HOMEPAGE: 2,
  NUM_PROJECTS_ON_HOMEPAGE: 3,
};

export const HOME: Metadata = {
  TITLE: "Home",
  DESCRIPTION: "Portfolio of Kongara Naveen, a Senior DevOps Engineer focused on cloud platform and reliability.",
};

export const BLOG: Metadata = {
  TITLE: "Blog",
  DESCRIPTION: "A collection of articles on topics I am passionate about.",
};

export const WORK: Metadata = {
  TITLE: "Work",
  DESCRIPTION: "Where I have worked and what I have done.",
};

export const PROJECTS: Metadata = {
  TITLE: "Projects",
  DESCRIPTION: "A collection of my projects, with links to repositories and demos.",
};

export const SOCIALS: Socials = [
  {
    NAME: "linkedin",
    HREF: "https://in.linkedin.com/in/kongara-naveen",
  },
  {
    NAME: "github",
    HREF: "https://github.com/CN-0",
  },
];
