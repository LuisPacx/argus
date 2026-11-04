# The War Room type-checks `.vue` files with vue-tsc on TypeScript 5

The TypeScript 7 native compiler (`tsc`) does not understand `.vue` files, and `vue-tsc` does not yet support TypeScript 7. The War Room therefore pins `typescript@5.9.3` and `vue-tsc@3.3.14` as devDependencies in `apps/warroom` only, and its typecheck runs both the TS7 `tsc --noEmit --checkers 1` (invoked from the root `node_modules/.bin`, since the local `tsc` bin is now TS5) and `vue-tsc --noEmit`, against the Nuxt-generated `.nuxt/tsconfig.json`.

This is the single exception to the TypeScript 7 convention. Drop `typescript@5` (and the dual check) once vue-tsc supports TypeScript 7.

## Considered Options

- **Skip type-checking `.vue` files**: template and script errors would only surface at runtime.
- **Move the whole repo back to TypeScript 5**: gives up the TS7 speed everywhere for one app.

## Consequences

- Two TypeScript versions exist in the workspace; only the War Room uses 5.x.
- The War Room typecheck is slower than other packages.
