CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),
    phone VARCHAR(20) UNIQUE NOT NULL,
    role VARCHAR(20) CHECK (role IN ('customer', 'rider', 'store_operator', 'admin')) DEFAULT 'customer',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    category VARCHAR(100),
    price DECIMAL(10,2) NOT NULL,
    image_url VARCHAR(500),
    stock_quantity INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 1. Create riders BEFORE orders
CREATE TABLE IF NOT EXISTS riders (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    vehicle_number VARCHAR(20),
    is_available BOOLEAN DEFAULT true
);

-- 2. Now orders can reference riders
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    customer_id INT REFERENCES users(id),
    status VARCHAR(20) CHECK (status IN ('placed', 'packed', 'assigned', 'picked_up', 'delivered', 'cancelled')) DEFAULT 'placed',
    total_amount DECIMAL(10,2),
    delivery_address TEXT,
    rider_id INT REFERENCES riders(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id INT REFERENCES orders(id) ON DELETE CASCADE,
    product_id INT REFERENCES products(id),
    quantity INT NOT NULL,
    price DECIMAL(10,2) NOT NULL
);

INSERT INTO products (name, category, price, image_url, stock_quantity)
SELECT * FROM (VALUES
    ('Banana', 'Fruits', 40, 'https://example.com/banana.jpg', 100),
    ('Milk', 'Dairy', 26, 'https://example.com/milk.jpg', 200),
    ('Bread', 'Bakery', 45, 'https://example.com/bread.jpg', 150),
    ('Eggs (6 pcs)', 'Dairy', 72, 'https://example.com/eggs.jpg', 80),
    ('Tomato', 'Vegetables', 30, 'https://example.com/tomato.jpg', 120),
    ('Onion', 'Vegetables', 35, 'https://example.com/onion.jpg', 130),
    ('Coca Cola', 'Beverages', 40, 'https://example.com/coke.jpg', 300),
    ('Potato Chips', 'Snacks', 20, 'https://example.com/chips.jpg', 500)
) AS tmp(name, category, price, image_url, stock_quantity)
WHERE NOT EXISTS (SELECT 1 FROM products LIMIT 1);