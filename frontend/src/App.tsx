/**
 * Domain Hub application entry composition.
 *
 * The legacy controller has been moved out of the root module so future feature
 * migrations can split application orchestration without growing App.tsx again.
 * Keep this file intentionally boring: it is the public application boundary.
 */
export { default } from "./app/AppController";
