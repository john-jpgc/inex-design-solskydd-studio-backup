/**
 * Databasschema. Varje migration körs en gång och registreras i schema_migrations.
 * Lägg nya ändringar som en ny post i listan – ändra aldrig en redan körd migration.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE staff_users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'warehouse', 'support')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  staff_user_id INTEGER NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  birth_date TEXT NOT NULL,
  street TEXT,
  postal_code TEXT,
  city TEXT,
  country TEXT NOT NULL DEFAULT 'SE',
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  pref_strength TEXT CHECK (pref_strength IS NULL OR pref_strength IN ('mild', 'medium', 'strong', 'extra_strong')),
  pref_flavors TEXT NOT NULL DEFAULT '[]',
  excluded_flavors TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customers_name ON customers(last_name, first_name);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  brand TEXT NOT NULL,
  flavor TEXT NOT NULL,
  strength TEXT NOT NULL CHECK (strength IN ('mild', 'medium', 'strong', 'extra_strong')),
  nicotine_mg REAL,
  format TEXT NOT NULL DEFAULT 'slim',
  price_ore INTEGER NOT NULL,
  vat_rate INTEGER NOT NULL DEFAULT 25,
  weight_grams INTEGER NOT NULL DEFAULT 20,
  active INTEGER NOT NULL DEFAULT 1,
  stock_on_hand INTEGER NOT NULL DEFAULT 0,
  stock_reserved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (stock_on_hand >= 0),
  CHECK (stock_reserved >= 0),
  CHECK (stock_reserved <= stock_on_hand)
);

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('purchase', 'adjustment', 'pick', 'return', 'correction')),
  reference TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_stock_movements_product ON stock_movements(product_id, created_at);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'picking', 'packed', 'shipped', 'delivered', 'cancelled', 'returned')),
  channel TEXT NOT NULL DEFAULT 'web',
  external_ref TEXT,
  payment_method TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid', 'refund_due', 'refunded')),
  payment_ref TEXT,
  ship_name TEXT NOT NULL,
  ship_street TEXT NOT NULL,
  ship_postal_code TEXT NOT NULL,
  ship_city TEXT NOT NULL,
  ship_country TEXT NOT NULL DEFAULT 'SE',
  ship_phone TEXT,
  subtotal_ore INTEGER NOT NULL,
  shipping_ore INTEGER NOT NULL,
  vat_ore INTEGER NOT NULL,
  total_ore INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'SEK',
  age_verified INTEGER NOT NULL DEFAULT 0,
  customer_note TEXT,
  internal_note TEXT,
  placed_at TEXT NOT NULL,
  paid_at TEXT,
  packed_at TEXT,
  shipped_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_orders_status ON orders(status, placed_at);
CREATE INDEX idx_orders_customer ON orders(customer_id, placed_at);
CREATE UNIQUE INDEX idx_orders_external_ref ON orders(external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('product', 'mystery_box')),
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_ore INTEGER NOT NULL,
  vat_rate INTEGER NOT NULL,
  box_size INTEGER,
  box_strength TEXT
);
CREATE INDEX idx_order_lines_order ON order_lines(order_id);

CREATE TABLE box_picks (
  id INTEGER PRIMARY KEY,
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_box_picks_line ON box_picks(order_line_id);
CREATE INDEX idx_box_picks_product ON box_picks(product_id);

CREATE TABLE shipments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  carrier TEXT NOT NULL,
  service TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  weight_grams INTEGER,
  pickup_point TEXT,
  shipped_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_shipments_order ON shipments(order_id);
CREATE INDEX idx_shipments_tracking ON shipments(tracking_number);

CREATE TABLE shipment_events (
  id INTEGER PRIMARY KEY,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  description TEXT,
  location TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_shipment_events_shipment ON shipment_events(shipment_id, occurred_at);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  box_size INTEGER NOT NULL CHECK (box_size > 0),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  strength TEXT CHECK (strength IS NULL OR strength IN ('mild', 'medium', 'strong', 'extra_strong')),
  price_ore INTEGER NOT NULL,
  interval_months INTEGER NOT NULL DEFAULT 1 CHECK (interval_months > 0),
  next_renewal_at TEXT NOT NULL,
  last_renewed_at TEXT,
  external_ref TEXT,
  payment_method TEXT,
  notes TEXT,
  last_error TEXT,
  started_at TEXT NOT NULL,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
CREATE INDEX idx_subscriptions_due ON subscriptions(status, next_renewal_at);
CREATE UNIQUE INDEX idx_subscriptions_external_ref ON subscriptions(external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE orders ADD COLUMN subscription_id INTEGER REFERENCES subscriptions(id);
ALTER TABLE orders ADD COLUMN period TEXT;
CREATE UNIQUE INDEX idx_orders_subscription_period ON orders(subscription_id, period) WHERE subscription_id IS NOT NULL;

ALTER TABLE shipments ADD COLUMN label_provider TEXT;
ALTER TABLE shipments ADD COLUMN label_ref TEXT;
ALTER TABLE shipments ADD COLUMN label_format TEXT;
ALTER TABLE shipments ADD COLUMN label_data BLOB;
ALTER TABLE shipments ADD COLUMN label_created_at TEXT;
`,
  },
];
