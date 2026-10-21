const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const {
    initializeApp,
    cert,
    getApps,
} = require('firebase-admin/app');

const { getAuth } = require('firebase-admin/auth');

const {
    MongoClient,
    ServerApiVersion,
    ObjectId,
} = require('mongodb');

const app = express();
const port = process.env.PORT || 3000;

// ==================== FIREBASE ====================

if (!getApps().length) {
    const decoded = Buffer.from(
        process.env.FB_SERVICE_KEY,
        'base64'
    ).toString('utf8');

    const serviceAccount = JSON.parse(decoded);

    initializeApp({
        credential: cert(serviceAccount),
    });
}

// ==================== MONGODB ====================

const username = encodeURIComponent(process.env.DB_USER);
const password = encodeURIComponent(process.env.DB_PASS);

const uri = `mongodb://${username}:${password}@ac-z4lejrv-shard-00-00.t7hbkhr.mongodb.net:27017,ac-z4lejrv-shard-00-01.t7hbkhr.mongodb.net:27017,ac-z4lejrv-shard-00-02.t7hbkhr.mongodb.net:27017/?ssl=true&replicaSet=atlas-o8z6bn-shard-0&authSource=admin&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
    serverSelectionTimeoutMS: 10000,
});

const db = client.db(
    process.env.DB_NAME || 'zap_shift_db'
);

const parcelCollection = db.collection('parcels');
const userCollection = db.collection('users');
const paymentCollection = db.collection('payment');
const ridersCollection = db.collection('riders');
const trackingCollection = db.collection('trackings');

// Reuse the MongoDB connection in warm serverless instances.
let clientPromise;

function connectDB() {
    if (!clientPromise) {
        clientPromise = client.connect().catch((error) => {
            clientPromise = null;
            throw error;
        });
    }

    return clientPromise;
}

// ==================== MIDDLEWARE ====================

app.use(cors());
app.use(express.json());

// Ensure MongoDB is connected before handling API requests.
app.use(async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (error) {
        console.error('MongoDB connection failed:', error.message);

        return res.status(503).send({
            message: 'Database connection failed',
        });
    }
});

// ==================== HELPER FUNCTIONS ====================

function generateTrackingId() {
    const date = new Date()
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, '');

    const randomCode = crypto
        .randomBytes(3)
        .toString('hex')
        .toUpperCase();

    return `TKW-${date}-${randomCode}`;
}

const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;

    if (!token || !token.startsWith('Bearer ')) {
        return res.status(401).send({
            message: 'Unauthorized access',
        });
    }

    try {
        const idToken = token.split(' ')[1];
        const decodedToken = await getAuth().verifyIdToken(idToken);

        req.decode_email = decodedToken.email;

        return next();
    } catch (error) {
        console.error('Firebase token verification failed:', error.message);

        return res.status(401).send({
            message: 'Unauthorized access',
        });
    }
};

const verifyAdmin = async (req, res, next) => {
    try {
        const email = req.decode_email;

        const user = await userCollection.findOne({ email });

        if (!user || user.role !== 'admin') {
            return res.status(403).send({
                message: 'Forbidden access',
            });
        }

        return next();
    } catch (error) {
        return next(error);
    }
};

const logTracking = async (trackingId, status) => {
    const log = {
        trackingId,
        status,
        details: status.split('-').join(' '),
        createdAt: new Date(),
    };

    return trackingCollection.insertOne(log);
};

// ==================== RIDERS API ====================

app.post('/riders', async (req, res) => {
    const rider = req.body;

    if (!rider || !rider.email) {
        return res.status(400).send({
            message: 'Rider information and email are required',
        });
    }

    const result = await ridersCollection.insertOne({
        ...rider,
        status: 'pending',
        applied_at: rider.applied_at || new Date().toISOString(),
    });

    return res.status(201).send(result);
});

app.get('/riders', async (req, res) => {
    const { status, district, workStatus } = req.query;
    const query = {};

    if (status) {
        query.status = status;
    }

    if (district) {
        query.district = district;
    }

    if (workStatus) {
        query.workStatus = workStatus;
    }

    const result = await ridersCollection.find(query).toArray();

    return res.send(result);
});

app.delete('/riders/:id', async (req, res) => {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
        return res.status(400).send({
            message: 'Invalid rider ID',
        });
    }

    const result = await ridersCollection.deleteOne({
        _id: new ObjectId(id),
    });

    return res.send(result);
});

app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
    const { status, email } = req.body;
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
        return res.status(400).send({
            message: 'Invalid rider ID',
        });
    }

    const result = await ridersCollection.updateOne(
        { _id: new ObjectId(id) },
        {
            $set: {
                status,
                workStatus: 'available',
            },
        }
    );

    if (status === 'approved') {
        if (!email) {
            return res.status(400).send({
                message: 'Rider email is required for approval',
            });
        }

        await userCollection.updateOne(
            { email },
            {
                $set: {
                    role: 'rider',
                },
            }
        );
    }

    return res.send(result);
});

// ==================== USERS API ====================

app.get('/users', verifyFBToken, async (req, res) => {
    const result = await userCollection.find().toArray();

    return res.send(result);
});

app.get('/users/:id', async (req, res) => {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
        return res.status(400).send({
            message: 'Invalid user ID',
        });
    }

    const user = await userCollection.findOne({
        _id: new ObjectId(id),
    });

    if (!user) {
        return res.status(404).send({
            message: 'User not found',
        });
    }

    return res.send(user);
});

app.get('/users/:email/role', async (req, res) => {
    const email = req.params.email;

    const user = await userCollection.findOne({ email });

    return res.send({
        role: user?.role || 'user',
    });
});

app.post('/users', async (req, res) => {
    try {
        const user = req.body;

        if (!user || !user.email) {
            return res.status(400).send({
                message: 'User email is required',
            });
        }

        const email = user.email;

        const userExists = await userCollection.findOne({ email });

        if (userExists) {
            return res.send({
                message: 'User Exists',
            });
        }

        const newUser = {
            ...user,
            role: 'user',
            createdAt: new Date(),
        };

        const result = await userCollection.insertOne(newUser);

        return res.status(201).send(result);
    } catch (error) {
        console.error('POST /users error:', error.message);

        return res.status(500).send({
            message: 'Failed to save user',
        });
    }
});

app.patch(
    '/users/:id/role',
    verifyFBToken,
    verifyAdmin,
    async (req, res) => {
        const id = req.params.id;
        const { role } = req.body;

        if (!ObjectId.isValid(id)) {
            return res.status(400).send({
                message: 'Invalid user ID',
            });
        }

        const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            {
                $set: { role },
            }
        );

        return res.send(result);
    }
);

// ==================== PARCELS API ====================

app.get('/parcels', async (req, res) => {
    const { email, deliveryStatus } = req.query;
    const query = {};

    if (email) {
        query.senderEmail = email;
    }

    if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
    }

    const result = await parcelCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

    return res.send(result);
});

app.get('/parcels/rider', async (req, res) => {
    const { riderEmail, deliveryStatus } = req.query;
    const query = {};

    if (riderEmail) {
        query.riderEmail = riderEmail;
    }

    if (deliveryStatus !== 'parcel-delivered') {
        query.deliveryStatus = {
            $nin: ['parcel-delivered'],
        };
    } else {
        query.deliveryStatus = deliveryStatus;
    }

    const result = await parcelCollection.find(query).toArray();

    return res.send(result);
});

app.get('/parcels/:id', async (req, res) => {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
        return res.status(400).send({
            message: 'Invalid parcel ID',
        });
    }

    const result = await parcelCollection.findOne({
        _id: new ObjectId(id),
    });

    if (!result) {
        return res.status(404).send({
            message: 'Parcel not found',
        });
    }

    return res.send(result);
});

app.post('/parcels', async (req, res) => {
    const parcel = req.body;

    if (!parcel || typeof parcel !== 'object') {
        return res.status(400).send({
            message: 'Parcel information is required',
        });
    }

    const trackingId = generateTrackingId();

    parcel.createdAt = new Date();
    parcel.trackingId = trackingId;

    const result = await parcelCollection.insertOne(parcel);

    await logTracking(trackingId, 'parcel-created');

    return res.status(201).send(result);
});

app.delete('/parcels/:id', async (req, res) => {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
        return res.status(400).send({
            message: 'Invalid parcel ID',
        });
    }

    const result = await parcelCollection.deleteOne({
        _id: new ObjectId(id),
    });

    return res.send(result);
});

app.patch('/parcels/:id', async (req, res) => {
    const { riderId, riderName, riderEmail, trackingId } = req.body;
    const id = req.params.id;

    if (!ObjectId.isValid(id) || !ObjectId.isValid(riderId)) {
        return res.status(400).send({
            message: 'Invalid parcel ID or rider ID',
        });
    }

    const result = await parcelCollection.updateOne(
        { _id: new ObjectId(id) },
        {
            $set: {
                deliveryStatus: 'driver-assigned',
                riderId,
                riderEmail,
                riderName,
            },
        }
    );

    await ridersCollection.updateOne(
        { _id: new ObjectId(riderId) },
        {
            $set: {
                workStatus: 'in-delivery',
            },
        }
    );

    await logTracking(trackingId, 'driver-assigned');

    return res.send(result);
});

app.patch('/parcels/:id/status', async (req, res) => {
    const id = req.params.id;
    const { deliveryStatus, riderId, trackingId } = req.body;

    if (!ObjectId.isValid(id)) {
        return res.status(400).send({
            message: 'Invalid parcel ID',
        });
    }

    if (
        deliveryStatus === 'parcel-delivered' &&
        !ObjectId.isValid(riderId)
    ) {
        return res.status(400).send({
            message: 'Valid rider ID is required',
        });
    }

    if (deliveryStatus === 'parcel-delivered') {
        await ridersCollection.updateOne(
            { _id: new ObjectId(riderId) },
            {
                $set: {
                    workStatus: 'available',
                },
            }
        );
    }

    const result = await parcelCollection.updateOne(
        { _id: new ObjectId(id) },
        {
            $set: {
                deliveryStatus,
            },
        }
    );

    await logTracking(trackingId, deliveryStatus);

    return res.send(result);
});

// ==================== STRIPE PAYMENT ====================

app.post('/payment-checkout-session', async (req, res) => {
    const paymentInfo = req.body;
    const amount = Number(paymentInfo.cost) * 100;

    if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !paymentInfo.parcelName ||
        !paymentInfo.senderEmail
    ) {
        return res.status(400).send({
            message: 'Valid payment information is required',
        });
    }

    const session = await stripe.checkout.sessions.create({
        line_items: [
            {
                price_data: {
                    currency: 'usd',
                    unit_amount: Math.round(amount),
                    product_data: {
                        name: `Please pay for ${paymentInfo.parcelName}`,
                    },
                },
                quantity: 1,
            },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: 'payment',
        metadata: {
            parcelId: paymentInfo.parcelId,
            trackingId: paymentInfo.trackingId,
            parcelName: paymentInfo.parcelName,
        },
        success_url:
            `${process.env.SITE_DOMAIN}/dashboard/payment-success` +
            '?session_id={CHECKOUT_SESSION_ID}',
        cancel_url:
            `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled` +
            '?session_id={CHECKOUT_SESSION_ID}',
    });

    return res.send({
        url: session.url,
    });
});

app.patch('/payment-success', async (req, res) => {
    const sessionId = req.query.session_id;

    if (!sessionId) {
        return res.status(400).send({
            message: 'Stripe session ID is required',
        });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
        return res.status(400).send({
            message: 'Payment has not been completed',
        });
    }

    const transactionId = session.payment_intent;

    const paymentExist = await paymentCollection.findOne({
        transactionId,
    });

    if (paymentExist) {
        return res.send({
            message: 'Already exists',
            transactionId,
            trackingId: paymentExist.trackingId,
        });
    }

    const trackingId = session.metadata.trackingId;
    const parcelId = session.metadata.parcelId;

    if (!ObjectId.isValid(parcelId)) {
        return res.status(400).send({
            message: 'Invalid parcel ID in payment session',
        });
    }

    const modifyParcel = await parcelCollection.updateOne(
        { _id: new ObjectId(parcelId) },
        {
            $set: {
                paymentStatus: 'paid',
                deliveryStatus: 'pending-pickup',
            },
        }
    );

    const payment = {
        amount: session.amount_total / 100,
        currency: session.currency,
        customerEmail: session.customer_email,
        parcelId,
        parcelName: session.metadata.parcelName,
        transactionId,
        paymentStatus: session.payment_status,
        paidAt: new Date(),
        trackingId,
    };

    const paymentInfoResult = await paymentCollection.insertOne(payment);

    await logTracking(trackingId, 'pending-pickup');

    return res.send({
        success: true,
        modifyParcel,
        paymentInfo: paymentInfoResult,
        transactionId,
        trackingId,
    });
});

app.get('/payments', verifyFBToken, async (req, res) => {
    const email = req.query.email;
    const query = {};

    if (email) {
        if (email !== req.decode_email) {
            return res.status(403).send({
                message: 'Forbidden access',
            });
        }

        query.customerEmail = email;
    }

    const result = await paymentCollection
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();

    return res.send(result);
});

// ==================== TRACKING API ====================

app.get('/trackings/:trackingId/logs', async (req, res) => {
    const trackingId = req.params.trackingId;

    const result = await trackingCollection
        .find({ trackingId })
        .toArray();

    return res.send(result);
});

// ==================== HOME ROUTE ====================

app.get('/', (req, res) => {
    return res.send('zap shift');
});

// ==================== ERROR HANDLER ====================

app.use((error, req, res, next) => {
    console.error('API error:', error.message);

    if (res.headersSent) {
        return next(error);
    }

    return res.status(500).send({
        message: 'Internal server error',
    });
});

// ==================== LOCAL / VERCEL ====================

// Run a local server only when executing this file directly.
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Zap Shift server running on port ${port}`);
    });
}

// Vercel can import the Express app.
module.exports = app;