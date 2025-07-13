require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMETN_GATEWAY);
const express = require("express");
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
const port = process.env.PORT || 3000;
const cors = require("cors");
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.1joky5l.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("percelDB");
    const percelCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payment");
    const userCollection = db.collection("users");

    // custom middleware
    const verifyToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      console.log(authHeader);

      if (!authHeader) {
        return res.status(401).send({ message: "unauthorize access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorize access" });
      }

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {}
    };
    // create user
    app.post("/users", async (req, res) => {
      const { email } = req.body;

      try {
        const existingUser = await userCollection.findOne({ email });

        if (existingUser) {
          return res.status(200).json({
            message: "User already exists",
            user: existingUser,
            inserted: false,
          });
        }

        const newUser = {
          email,
          role: "user", // default role
          createdAt: new Date(),
        };

        const result = await userCollection.insertOne(newUser);
        res.status(201).json({
          message: "New user created",
          user: result.ops?.[0] || newUser,
        });
        // res.send(result);
      } catch (error) {
        console.error("Error creating/finding user:", error);
        res.status(500).json({ message: "Server error" });
      }
    });
    // ,,,,,,,,,,,,,,,,,,,,,,,,
    // percels
    app.get("/parcels", async (req, res) => {
      const result = await percelCollection.find().toArray();
      res.send(result);
    });

    // get percel by ids
    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;

      try {
        const parcel = await percelCollection.findOne({
          _id: new ObjectId(id),
        });

        res.send(parcel);
      } catch (error) {
        res.status(400).json({ error: "Invalid parcel ID" });
      }
    });
    app.get("/parcels", async (req, res) => {
      const email = req.query.email;

      try {
        const query = email ? { created_by: email } : {};
        const options = {
          sort: { createdAt: -1 }, // Newest first
        };

        const results = await percelCollection.find(query, options).toArray();
        res.status(200).json(results);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).json({ error: "Failed to fetch parcels" });
      }
    });

    app.post("/parcels", async (req, res) => {
      const newPercel = req.body;
      const result = await percelCollection.insertOne(newPercel);
      res.send(result);
    });
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;

      const query = { _id: new ObjectId(id) };
      try {
        const result = await percelCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        res.status(400).json({ error: "Invalid parcel ID" });
      }
    });

    // create custom method
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const amountIncent = req.body.amountIncent;

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountIncent,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });
    //  get data
    app.get("/payments", verifyToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        console.log("decoded ", req.decoded);
        if (req.decoded.email !== userEmail) {
          res.status(403).send({ message: "forbidden access" });
        }

        const email = req.query.email;

        const filter = email ? { email } : {};

        const payments = await paymentsCollection
          .find(filter)
          .sort({ paid_At: -1 }) // Descending by date (latest first)
          .toArray();

        res.status(200).json(payments);
      } catch (error) {
        res
          .status(500)
          .json({ message: "Failed to load payment history", error });
      }
    });

    // update history
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, amount, transactionId, email, paymentMethod } =
          req.body;
        // 2. Update parcel status
        await percelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { payment_status: "paid" } }
        );

        const parcelObjectId = new ObjectId(parcelId);

        // 1. Insert into payments collection
        const paymentData = {
          parcelId: parcelObjectId,
          amount,
          transactionId,
          email,
          paymentMethod,
          paid_at_string: new Date().toISOString(),
          paid_At: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(paymentData);

        res.status(200).json({
          message: "Payment saved and parcel updated",
          paymentId: paymentResult.insertedId,
        });
        // res.send(paymentResult);
      } catch (error) {
        res.status(500).json({ message: "Payment processing failed", error });
      }
    });

    // tracking
    app.post("/tracking", async (req, res) => {
      const {
        tracking_id,
        parcel_id,
        status,
        message,
        updated_by = "",
      } = req.body;

      const log = {
        tracking_id,
        parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
        status,
        message,
        time: new Date(),
        updated_by,
      };

      const result = await trackingCollection.insertOne(log);
      res.send({ success: true, insertedId: result.insertedId });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("App is running in the server");
});
app.listen(port, () => {
  console.log(`Currently running in the port ${port}`);
});
