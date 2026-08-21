// Entry point for the bundled check-packages gate (scripts/check-packages.mjs bundles this).
// Re-exports the catalog loader; async is fine here (the wrapper awaits via top-level require
// + promise). The wrapper treats a rejection with name CatalogValidationError as validation
// failure and anything else as an infrastructure error.
export { loadPackagesCatalog, CatalogValidationError } from '../src/catalog/load-packages';
