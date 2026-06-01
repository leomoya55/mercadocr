/**
 * categories.js — SINGLE SOURCE OF TRUTH for the category taxonomy.
 *
 * This file is a UMD module: it works both
 *   • in the browser  → exposes `window.Taxonomy`
 *   • in Node (server) → `require('../../js/categories')`
 *
 * WHY ONE FILE: categories used to be hardcoded as string literals in 5 places
 * (publish.html, listings.html, listings.js, server route validation, OG meta).
 * Any new category meant editing all of them and risking drift. Now every
 * consumer reads from here, so adding a category or subcategory is a one-line
 * change that the whole app (frontend + backend validation) picks up.
 *
 * BACKWARD COMPAT: the `value` of each top-level category MUST exactly match the
 * strings already stored in the `category` field of existing listings. Do not
 * rename a `value` without a data migration. `label` is display-only and can
 * change freely.
 *
 * SUBCATEGORIES: optional everywhere. A listing may have subcategory === '' .
 * This keeps publishing fast (subcategory is never required) while still letting
 * users narrow their listing and buyers filter by it.
 */
(function (root, factory) {
  const taxonomy = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = taxonomy;
  }
  if (typeof window !== 'undefined') {
    window.Taxonomy = taxonomy;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // ─── The taxonomy ────────────────────────────────────────────────────────────
  // Each category: { value, label, icon, subcategories: [string, ...] }
  // Subcategory entries are plain strings — their value === their label.
  const CATEGORIES = [
    {
      value: 'Ropa y accesorios', label: 'Ropa y accesorios', icon: '👕',
      subcategories: [
        'Ropa hombre', 'Ropa mujer', 'Ropa bebé', 'Zapatos',
        'Bolsos', 'Relojes', 'Joyería', 'Otros',
      ],
    },
    {
      value: 'Electrónica', label: 'Electrónica', icon: '📱',
      subcategories: [
        'Celulares', 'Laptops', 'Tablets', 'Videojuegos',
        'Componentes de PC', 'Audio', 'Cámaras', 'Televisores', 'Otros',
      ],
    },
    {
      value: 'Hogar y muebles', label: 'Hogar y muebles', icon: '🛋️',
      subcategories: [
        'Muebles', 'Electrodomésticos', 'Decoración',
        'Cocina', 'Jardín', 'Herramientas', 'Otros',
      ],
    },
    {
      value: 'Vehículos', label: 'Vehículos', icon: '🚗',
      subcategories: [
        'Automóviles', 'Motocicletas', 'Repuestos',
        'Bicicletas', 'Náutica', 'Otros',
      ],
    },
    {
      // Bienes Raíces has its own structured fields (operation / propertyType),
      // so it intentionally has no subcategory list — propertyType plays that role.
      value: 'Bienes Raíces', label: 'Bienes Raíces', icon: '🏠',
      subcategories: [],
    },
    {
      // Empleos lives on its own page with dedicated job fields.
      value: 'Empleos', label: 'Empleos', icon: '💼',
      subcategories: [],
    },
    {
      value: 'Servicios', label: 'Servicios', icon: '🛠️',
      subcategories: [
        'Hogar', 'Construcción', 'Belleza', 'Educación',
        'Tecnología', 'Eventos', 'Transporte', 'Otros',
      ],
    },
    {
      value: 'Otros', label: 'Otros', icon: '📦',
      subcategories: [],
    },
  ];

  // ─── Derived lookups (built once) ──────────────────────────────────────────
  const BY_VALUE = {};
  CATEGORIES.forEach(function (c) { BY_VALUE[c.value] = c; });

  /** All valid top-level category values. */
  function categoryValues() {
    return CATEGORIES.map(function (c) { return c.value; });
  }

  /** The category object for a value, or null. */
  function getCategory(value) {
    return BY_VALUE[value] || null;
  }

  /** Subcategory list for a category value (empty array if none / unknown). */
  function subcategoriesFor(value) {
    const c = BY_VALUE[value];
    return c && Array.isArray(c.subcategories) ? c.subcategories.slice() : [];
  }

  /** True if `value` is a known top-level category. */
  function isValidCategory(value) {
    return Object.prototype.hasOwnProperty.call(BY_VALUE, value);
  }

  /**
   * True if `sub` is a valid subcategory for `category`.
   * An empty subcategory is always valid (it is optional). A subcategory on a
   * category that has no subcategory list is rejected.
   */
  function isValidSubcategory(category, sub) {
    if (!sub) return true; // optional
    const list = subcategoriesFor(category);
    return list.indexOf(sub) !== -1;
  }

  /**
   * Normalize a (category, subcategory) pair: returns a clean subcategory string,
   * dropping it to '' if it isn't valid for the category. Never throws.
   */
  function normalizeSubcategory(category, sub) {
    return isValidSubcategory(category, sub) ? (sub || '') : '';
  }

  return {
    CATEGORIES,
    categoryValues,
    getCategory,
    subcategoriesFor,
    isValidCategory,
    isValidSubcategory,
    normalizeSubcategory,
  };
});
