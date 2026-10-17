const express = require('express');
const app = express();
const cors = require('cors')
require('dotenv').config();
const port = process.env.PORT || 3000;

const crypto = require("crypto");
// const { getAuth } = require("firebase-admin/auth");
const { initializeApp, cert, getApps } = require("firebase-admin/app");


const admin = require("firebase-admin");

// const serviceAccount = require("./zap-shift-fa680-firebase-adminsdk-fbsvc-76807b1d7c.json");

// const serviceAccount = require("./firebase-admin-key.json");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount)
    });
}


function generateTrackingId() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

    const randomCode = crypto
        .randomBytes(3)
        .toString("hex")
        .toUpperCase();

    return `TKW-${date}-${randomCode}`;
}

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { getAuth } = require('firebase-admin/auth');
const uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@ac-z4lejrv-shard-00-00.t7hbkhr.mongodb.net:27017,ac-z4lejrv-shard-00-01.t7hbkhr.mongodb.net:27017,ac-z4lejrv-shard-00-02.t7hbkhr.mongodb.net:27017/?ssl=true&replicaSet=atlas-o8z6bn-shard-0&authSource=admin&appName=Cluster0`;
const stripe = require('stripe')(process.env.STRIPE_SECRET);


// middleware

app.use(express.json())
app.use(cors())


const verifyFBToken = async (req, res, next) => {

    const token = req.headers.authorization;
    // console.log(token)

    if (!token) {
        return res.status(401).send({ message: 'Unauthorization access' })
    }


    try {
        const idToken = token.split(' ')[1];
        const decoded = await getAuth().verifyIdToken(idToken)

        req.decode_email = decoded.email;
        next();
    }
    catch (err) {
        console.log(err.message)
        return res.status(401).send({ message: 'unauthorized access' })
    }


}


// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});


async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();


        const db = client.db('zap_shift_db');
        const parcelCollection = db.collection('parcels')
        const userCollection = db.collection('users')
        const paymentCollection = db.collection('payment')
        const ridersCollection = db.collection('riders')
        const trackingCollection = db.collection('trackings')


        const verifyAdmin = async (req, res, next) => {
            const email = req.decode_email;
            const query = { email }
            const user = await userCollection.findOne(query)

            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        }


        const logTracking = async (trackingId, status) => {
            const log = {
                trackingId,
                status,
                details: status.split('-').join(' '),
                createdAt: new Date()
            }


            const result = await trackingCollection.insertOne(log);
            return result
        }

        // riders api
        app.post('/riders', async (req, res) => {
            const rider = req.body;

            const result = await ridersCollection.insertOne(rider);

            res.send(result)
        })


        app.get('/riders', async (req, res) => {
            const { status, district, workStatus } = req.query;
            const query = {};
            if (req.query.status) {
                query.status = req.query.status;
            }

            if (district) {
                query.district = district
            }

            if (workStatus) {
                query.workStatus = workStatus
            }

            if (status) {
                query.status = status
            }



            const cursor = ridersCollection.find(query);
            const result = await cursor.toArray();
            res.send(result)
        })


        app.delete('/riders/:id', async (req, res) => {
            const id = req.params.id;

            const query = { _id: new ObjectId(id) }


            const result = await ridersCollection.deleteOne(query);
            res.send(result)
        })

        app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
            const status = req.body.status;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const updateDoc = {
                $set: {
                    status: status,
                    workStatus: 'available'
                }
            }

            const result = await ridersCollection.updateOne(query, updateDoc);



            if (status === 'approved') {
                const email = req.body.email;
                const userQuery = { email };
                const updateUser = {
                    $set: {
                        role: 'rider'
                    }
                }

                const userResult = await userCollection.updateOne(userQuery, updateUser)

            }

            res.send(result)
        })

        // user api


        app.get('/users', verifyFBToken, async (req, res) => {
            const cursor = userCollection.find();
            const result = await cursor.toArray();
            res.send(result)
        })

        app.get('/users/:id', async (req, res) => {

        })

        app.get('/users/:email/role', async (req, res) => {
            const email = req.params.email;
            const query = { email }
            const user = await userCollection.findOne(query);
            res.send({ role: user?.role || 'user' })
        })

        app.post('/users', async (req, res) => {
            const user = req.body;
            user.role = 'user';
            user.createdAt = new Date();

            const email = user.email;
            const userExists = await userCollection.findOne({ email })

            if (userExists) {
                return res.send({ message: 'User Exists' })
            }

            const result = await userCollection.insertOne(user);
            res.send(result)
        })


        app.patch('/users/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const roleInfo = req.body;
            const query = { _id: new ObjectId(id) }
            const updateDoc = {
                $set: {
                    role: roleInfo.role
                }
            }
            const result = await userCollection.updateOne(query, updateDoc);
            res.send(result)
        })




        // parcel api


        app.get('/parcels', async (req, res) => {
            const query = {};
            const { email, deliveryStatus } = req.query;
            if (email) {
                query.senderEmail = email
            }


            if (deliveryStatus) {
                query.deliveryStatus = deliveryStatus;
            }

            const option = {
                sort: { createdAt: - 1 }
            }



            const cursor = await parcelCollection.find(query, option)
            const result = await cursor.toArray();
            res.send(result);
        })

        app.get('/parcels/rider', async (req, res) => {
            const { riderEmail, deliveryStatus } = req.query;

            const query = {}

            if (riderEmail) {
                query.riderEmail = riderEmail
            }
            if (deliveryStatus !== 'parcel-delivered') {
                // query.deliveryStatus = {$in: ['driver-assigned', 'rider-arriving']}
                query.deliveryStatus = { $nin: ['parcel-delivered'] }
            }
            else {
                query.deliveryStatus = deliveryStatus
            }

            const cursor = parcelCollection.find(query);
            const result = await cursor.toArray();

            res.send(result)
        })

        app.get('/parcels/:id', async (req, res) => {
            const id = req.params.id;

            const query = { _id: new ObjectId(id) };

            const result = await parcelCollection.findOne(query);
            res.send(result)
        })


        app.post('/parcels', async (req, res) => {
            const parcel = req.body;
            const trackingId = generateTrackingId();



            parcel.createdAt = new Date();
            parcel.trackingId = trackingId;

            logTracking(trackingId, 'parcel-created')

            const result = await parcelCollection.insertOne(parcel);
            // console.log(result)
            res.send(result)
        })


        app.delete('/parcels/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }

            const result = await parcelCollection.deleteOne(query)
            res.send(result)
        })


        app.patch('/parcels/:id', async (req, res) => {
            const { riderId, riderName, riderEmail, trackingId } = req.body;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            const updatedDoc = {
                $set: {
                    deliveryStatus: 'driver-assigned',
                    riderId: riderId,
                    riderEmail: riderEmail,
                    riderName: riderName
                }
            }

            const result = await parcelCollection.updateOne(query, updatedDoc);

            const riderQuery = { _id: new ObjectId(riderId) }
            const riderUpdateDoc = {
                $set: {
                    workStatus: 'in-delivery'
                }
            }

            const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdateDoc);

            logTracking(trackingId, 'driver-assigned')

            res.send(riderResult)

        })

        app.patch('/parcels/:id/status', async (req, res) => {
            const id = req.params.id;
            const { deliveryStatus, riderId, trackingId } = req.body;

            const query = { _id: new ObjectId(id) };

            const updatedDoc = {
                $set: {
                    deliveryStatus: deliveryStatus
                }
            }


            if (deliveryStatus === 'parcel-delivered') {
                const riderQuery = { _id: new ObjectId(riderId) }
                const riderUpdateDoc = {
                    $set: {
                        workStatus: 'available'
                    }
                }

                const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdateDoc)
            }

            const result = await parcelCollection.updateOne(query, updatedDoc);
            logTracking(trackingId, deliveryStatus)
            res.send(result)
        })



        app.post('/payment-checkout-session', async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100;

            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            unit_amount: amount,
                            product_data: {
                                name: `Please pay for ${paymentInfo.parcelName}`
                            },

                        },
                        quantity: 1,
                    }
                ],
                customer_email: paymentInfo.senderEmail,
                mode: 'payment',
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    trackingId: paymentInfo.trackingId,
                    parcelName: paymentInfo.parcelName
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled?session_id={CHECKOUT_SESSION_ID}`
            })

            res.send({ url: session.url })
        })



        // app.post('/create-checkout-session', async (req, res) => {
        //     const paymentInfo = req.body;
        //     const amount = parseInt(paymentInfo.cost) * 100;

        //     const session = await stripe.checkout.sessions.create({
        //         line_items: [
        //             {
        //                 price_data: {
        //                     currency: 'usd',
        //                     unit_amount: amount,
        //                     product_data: {
        //                         name: paymentInfo.parcelName,
        //                     },
        //                 },
        //                 quantity: 1,
        //             },
        //         ],
        //         customer_email: paymentInfo.senderEmail,
        //         mode: 'payment',
        //         metadata: {
        //             parcelId: paymentInfo.parcelId,
        //             parcelName: paymentInfo.parcelName
        //         },
        //         success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
        //         cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
        //     });

        //     console.log(session);
        //     res.send({ url: session.url });
        // });



        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id;

            const session = await stripe.checkout.sessions.retrieve(sessionId)
            // console.log(session)

            const transactionId = session.payment_intent;
            const query = { transactionId: transactionId }

            const paymentExist = await paymentCollection.findOne(query);
            console.log(paymentExist)

            if (paymentExist) {
                return res.send({ messege: 'already exist', transactionId, trackingId: paymentExist.trackingId })
            }


            const trackingId = session.metadata.trackingId;

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) };

                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        deliveryStatus: 'pending-pickup',
                    }
                }

                const result = await parcelCollection.updateOne(query, update);

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId
                }

                if (session.payment_status === 'paid') {
                    const resultPayment = await paymentCollection.insertOne(payment);

                    logTracking(trackingId, 'pending-pickup')

                    return res.send({ success: true, modifyParcel: result, paymentInfo: resultPayment, transactionId: session.payment_intent, trackingId: trackingId })
                }




                return res.send({ success: true })
            }




            res.send({ success: true })
        })


        app.get('/payments', verifyFBToken, async (req, res) => {
            const email = req.query.email;
            const query = {};


            // console.log(req.headers)

            if (email) {
                query.customerEmail = email


                if (email !== req.decode_email) {
                    return res.status(403).send({ message: 'forbidden access' })
                }
            }

            const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
            const result = await cursor.toArray();
            res.send(result)
        })


        // tracking related apis
        app.get(`/trackings/:trackingId/logs`, async (req, res) => {
            const trackingId = req.params.trackingId;
            const query = { trackingId };
            const result = await trackingCollection.find(query).toArray();
            res.send(result)
        })


        // Send a ping to confirm a successful connection
        // await client.db("admin").command({ ping: 1 });
        // console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    console.log("hhhhhhhhhhh")
    res.send('zap shift')
})

app.listen(port, "127.0.0.1", () => {
    console.log(`Example app listening on port ${port}`)
})

module.exports = app;