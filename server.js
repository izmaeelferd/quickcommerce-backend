require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database pool
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

pool.query('SELECT NOW()').then(() => console.log('Database connected'));

// ----- Socket.io setup -----
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.set('io', io);

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('join', (userId) => {
        socket.join(`user_${userId}`);
        console.log(`User ${userId} joined room`);
    });
});

// ----- In‑memory OTP store -----
const otpStore = new Map();

// ---------- AUTH ROUTES ----------
app.post('/api/auth/send-otp', async (req, res) => {
    const { phone, role } = req.body;
    if (!phone || phone.length < 10) {
        return res.status(400).json({ error: 'Valid phone number required' });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(phone, { otp, expiresAt: Date.now() + 5 * 60 * 1000, role: role || 'customer' });
    console.log(`🔐 OTP for ${phone} (${role || 'customer'}): ${otp}`);
    res.json({ message: 'OTP sent', otp });
});

app.post('/api/auth/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });

    const record = otpStore.get(phone);
    if (!record) return res.status(400).json({ error: 'OTP not sent or expired' });
    if (Date.now() > record.expiresAt) {
        otpStore.delete(phone);
        return res.status(400).json({ error: 'OTP expired' });
    }
    if (record.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });

    otpStore.delete(phone);

    let userResult = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    let user;
    if (userResult.rows.length === 0) {
        const insertResult = await pool.query(
            'INSERT INTO users (phone, role) VALUES ($1, $2) RETURNING *',
            [phone, record.role || 'customer']
        );
        user = insertResult.rows[0];
    } else {
        user = userResult.rows[0];
        // Update role if requested
        if (record.role && user.role !== record.role) {
            await pool.query('UPDATE users SET role = $1 WHERE id = $2', [record.role, user.id]);
            user.role = record.role;
        }
    }

    const token = jwt.sign(
        { userId: user.id, phone: user.phone, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );

    res.json({ token, user: { id: user.id, phone: user.phone, role: user.role } });
});

// ---------- AUTH MIDDLEWARE ----------
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer '))
        return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// ---------- PUBLIC ROUTES ----------
app.get('/', (req, res) => res.send('QuickCommerce API is running'));

app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- CUSTOMER ROUTES ----------
app.post('/api/orders', authMiddleware, async (req, res) => {
    const userId = req.user.userId;
    const { items, delivery_address } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'items are required' });

    try {
        let total = 0;
        for (const item of items) {
            const prod = await pool.query('SELECT price FROM products WHERE id = $1', [item.product_id]);
            if (prod.rows.length === 0)
                return res.status(400).json({ error: `Product ${item.product_id} not found` });
            total += prod.rows[0].price * item.quantity;
        }

        const orderResult = await pool.query(
            'INSERT INTO orders (customer_id, total_amount, delivery_address) VALUES ($1, $2, $3) RETURNING id',
            [userId, total, delivery_address || '']
        );
        const orderId = orderResult.rows[0].id;

        for (const item of items) {
            const prod = await pool.query('SELECT price FROM products WHERE id = $1', [item.product_id]);
            const price = prod.rows[0].price;
            await pool.query(
                'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)',
                [orderId, item.product_id, item.quantity, price]
            );
        }

        res.status(201).json({ order_id: orderId, total_amount: total });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/orders', authMiddleware, async (req, res) => {
    const userId = req.user.userId;
    try {
        const ordersResult = await pool.query(
            'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        const orders = ordersResult.rows;
        for (let order of orders) {
            const itemsResult = await pool.query(
                'SELECT oi.*, p.name FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1',
                [order.id]
            );
            order.items = itemsResult.rows;
        }
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- STORE OPERATOR ROUTES ----------
function storeOperatorMiddleware(req, res, next) {
    if (req.user.role !== 'store_operator') return res.status(403).json({ error: 'Access denied' });
    next();
}

app.get('/api/store/orders/new', authMiddleware, storeOperatorMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM orders WHERE status = $1 ORDER BY created_at ASC',
            ['placed']
        );
        for (let order of result.rows) {
            const itemsResult = await pool.query(
                'SELECT oi.*, p.name FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1',
                [order.id]
            );
            order.items = itemsResult.rows;
        }
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/store/orders/:orderId/pack', authMiddleware, storeOperatorMiddleware, async (req, res) => {
    const orderId = req.params.orderId;
    try {
        const result = await pool.query(
            'UPDATE orders SET status = $1 WHERE id = $2 AND status = $3 RETURNING *',
            ['packed', orderId, 'placed']
        );
        if (result.rows.length === 0) return res.status(400).json({ error: 'Order not found or already processed' });

        const order = result.rows[0];
        // Emit to customer
        io.to(`user_${order.customer_id}`).emit('orderStatusChanged', {
            orderId: order.id,
            status: 'packed',
        });
        // Notify all riders that a new order is available
        io.emit('newOrderAvailable');

        res.json(order);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- RIDER ROUTES ----------
function riderMiddleware(req, res, next) {
    if (req.user.role !== 'rider') return res.status(403).json({ error: 'Access denied' });
    next();
}

app.get('/api/rider/orders/new', authMiddleware, riderMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM orders WHERE status = $1 AND rider_id IS NULL ORDER BY created_at ASC',
            ['packed']
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/rider/orders/:orderId/accept', authMiddleware, riderMiddleware, async (req, res) => {
    const riderId = req.user.userId;
    const orderId = req.params.orderId;

    try {
        const riderResult = await pool.query('SELECT id FROM riders WHERE user_id = $1', [riderId]);
        if (riderResult.rows.length === 0) return res.status(400).json({ error: 'Rider profile not found' });
        const riderDbId = riderResult.rows[0].id;

        const updateResult = await pool.query(
            'UPDATE orders SET rider_id = $1, status = $2 WHERE id = $3 AND status = $4 AND rider_id IS NULL RETURNING *',
            [riderDbId, 'assigned', orderId, 'packed']
        );
        if (updateResult.rows.length === 0) return res.status(400).json({ error: 'Order already taken or invalid' });

        const order = updateResult.rows[0];
        // Emit to customer
        io.to(`user_${order.customer_id}`).emit('orderStatusChanged', {
            orderId: order.id,
            status: 'assigned',
        });

        res.json(order);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/rider/orders/:orderId/status', authMiddleware, riderMiddleware, async (req, res) => {
    const { status } = req.body;
    const validStatuses = ['picked_up', 'delivered'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const orderId = req.params.orderId;
    try {
        // Fetch the order first to get customer_id
        const orderQuery = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
        if (orderQuery.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

        const result = await pool.query(
            'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
            [status, orderId]
        );

        const updatedOrder = result.rows[0];
        // Emit to customer
        io.to(`user_${updatedOrder.customer_id}`).emit('orderStatusChanged', {
            orderId: updatedOrder.id,
            status: status,
        });

        res.json(updatedOrder);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/rider/orders/my', authMiddleware, riderMiddleware, async (req, res) => {
    const riderId = req.user.userId;
    try {
        const riderResult = await pool.query('SELECT id FROM riders WHERE user_id = $1', [riderId]);
        if (riderResult.rows.length === 0) return res.status(400).json({ error: 'Rider not found' });
        const riderDbId = riderResult.rows[0].id;

        const ordersResult = await pool.query(
            'SELECT * FROM orders WHERE rider_id = $1 AND status NOT IN ($2, $3) ORDER BY created_at ASC',
            [riderDbId, 'delivered', 'cancelled']
        );
        res.json(ordersResult.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- ADMIN ROUTES ----------
function adminMiddleware(req, res, next) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access only' });
    next();
}

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const ordersCount = await pool.query('SELECT COUNT(*) FROM orders');
        const revenue = await pool.query('SELECT SUM(total_amount) FROM orders');
        const usersCount = await pool.query('SELECT COUNT(*) FROM users');
        const ridersCount = await pool.query('SELECT COUNT(*) FROM riders');
        const productsCount = await pool.query('SELECT COUNT(*) FROM products');
        res.json({
            totalOrders: ordersCount.rows[0].count,
            totalRevenue: revenue.rows[0].sum || 0,
            totalUsers: usersCount.rows[0].count,
            totalRiders: ridersCount.rows[0].count,
            totalProducts: productsCount.rows[0].count,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/products', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/products', authMiddleware, adminMiddleware, async (req, res) => {
    const { name, category, price, image_url, stock_quantity } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'Name and price required' });
    try {
        const result = await pool.query(
            'INSERT INTO products (name, category, price, image_url, stock_quantity) VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [name, category || '', price, image_url || '', stock_quantity || 0]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/products/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const id = req.params.id;
    const { name, category, price, image_url, stock_quantity } = req.body;
    try {
        const result = await pool.query(
            'UPDATE products SET name=$1, category=$2, price=$3, image_url=$4, stock_quantity=$5 WHERE id=$6 RETURNING *',
            [name, category, price, image_url, stock_quantity, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/products/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const id = req.params.id;
    try {
        await pool.query('DELETE FROM products WHERE id=$1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/orders', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { status } = req.query;
        let query = 'SELECT o.*, u.phone AS customer_phone, r.user_id AS rider_user_id FROM orders o LEFT JOIN users u ON o.customer_id = u.id LEFT JOIN riders r ON o.rider_id = r.id';
        const params = [];
        if (status) {
            query += ' WHERE o.status = $1';
            params.push(status);
        }
        query += ' ORDER BY o.created_at DESC';
        const result = await pool.query(query, params);
        for (let order of result.rows) {
            const items = await pool.query(
                'SELECT oi.*, p.name FROM order_items oi JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1',
                [order.id]
            );
            order.items = items.rows;
        }
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/orders/:id/status', authMiddleware, adminMiddleware, async (req, res) => {
    const id = req.params.id;
    const { status } = req.body;
    try {
        const result = await pool.query('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *', [status, id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/orders/:id/assign-rider', authMiddleware, adminMiddleware, async (req, res) => {
    const orderId = req.params.id;
    const { rider_id } = req.body;
    try {
        const riderResult = await pool.query('SELECT id FROM riders WHERE user_id=$1', [rider_id]);
        if (riderResult.rows.length === 0) return res.status(400).json({ error: 'Rider not found' });
        const riderDbId = riderResult.rows[0].id;
        const result = await pool.query(
            'UPDATE orders SET rider_id=$1, status=\'assigned\' WHERE id=$2 AND status=\'packed\' RETURNING *',
            [riderDbId, orderId]
        );
        if (result.rows.length === 0) return res.status(400).json({ error: 'Order not available for assignment' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/riders', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT r.*, u.phone, u.name FROM riders r JOIN users u ON r.user_id = u.id ORDER BY r.id'
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/riders', authMiddleware, adminMiddleware, async (req, res) => {
    const { user_id, vehicle_number } = req.body;
    if (!user_id) return res.status(400).json({ error: 'User ID required' });
    try {
        await pool.query('UPDATE users SET role=\'rider\' WHERE id=$1', [user_id]);
        const result = await pool.query(
            'INSERT INTO riders (user_id, vehicle_number) VALUES ($1, $2) RETURNING *',
            [user_id, vehicle_number || '']
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/riders/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const id = req.params.id;
    try {
        await pool.query('DELETE FROM riders WHERE user_id=$1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/store-operators', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM users WHERE role='store_operator'");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- START SERVER ----------
httpServer.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

// ---------- PAYMENT ROUTE ----------
const Razorpay = require('razorpay');
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_yourkey',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'yoursecret',
});

app.post('/api/payment/create-order', authMiddleware, async (req, res) => {
    const userId = req.user.userId;
    const { amount, currency } = req.body; // amount in paise (e.g., 50000 = ₹500)

    if (!amount || amount < 100) return res.status(400).json({ error: 'Invalid amount' });

    try {
        const options = {
            amount: amount,          // paise
            currency: currency || 'INR',
            receipt: `order_${Date.now()}`,
        };
        const razorpayOrder = await razorpay.orders.create(options);
        res.json({
            razorpayOrderId: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
