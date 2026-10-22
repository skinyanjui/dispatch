import { defineConfig } from "eslint/config";
import next from "eslint-config-next/core-web-vitals";
export default defineConfig([
  ...next,
  { ignores: ["dist/**", "public/**", ".next/**"] },
  {
    // This rule reads Pages Router layouts. It treats the App Router catch-all
    // `src/app/[[...path]]` (ADR 0045) as a page that matches every plain link
    // and asks for <Link> on `/terms`, `/demo` and the like.
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
]);
