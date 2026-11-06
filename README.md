# naveen-kongara.github.io

Personal portfolio and blog for Kongara Naveen, Senior DevOps Engineer.

Live at [naveen-kongara.github.io](https://naveen-kongara.github.io).

## Commands

All commands are run from the root of the project, from a terminal:

| Command           | Action                                      |
| :----------------- | :------------------------------------------ |
| `npm install`       | Installs dependencies                        |
| `npm run dev`        | Starts local dev server at `localhost:4321`  |
| `npm run build`      | Build the production site to `./dist/`       |
| `npm run preview`    | Preview the build locally before deploying   |
| `npm run typecheck`  | Run Astro's type checker                     |
| `npm run lint`       | Run ESLint                                   |
| `npm run lint:fix`   | Auto-fix ESLint issues                       |

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the site and publishes it to GitHub Pages.
