// Imports
const axios = require('axios');
const express = require('express');
const ngrok = require('ngrok');

let configPath = {url: '', port: 3008};

// Express server configuration
const app = express();
app.use(express.urlencoded({extended: true}));
app.use(express.json());
app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Switch credentials (available in Switch Dashboard)
const switchKeys = {
    accountId: '',
    privateKey: '',
    publicKey: ''
};

// Switch URL
const switchUrl = 'https://api-test.switchpayments.com/v2/';

/**
 * E-commerce page
 * Lets the client choose what he wants to purchase
 */
app.get('/', (req, res) => {

    // Get the product from the DB
    let product = DB.getProduct('sku42');

    // Send the response
    res.send(`
        <html>
            <p>MERCHANT STORE</p>
            <form method="POST" action="/order">
                <legend> ${product.name} || Price: ${product.price} ${product.currency} </legend>
                <label>Quantity:</label>
                <input name="quantity" type="number" value="1">
                <input name="item" type="hidden" value="sku42">
                <input type="submit" value="Buy">
            </form>
        </html>
    `);
});

/**
 * Payment page with the Dynamic Forms
 * Creates an order and then instantiates the Dynamic Forms
 */
app.post('/order', (req, res) => {

    // Gets the product form the DB
    let product = DB.getProduct(req.body.item);

    // Creates an order
    let orderId = DB.createOrder({
        itemId: req.body.item,
        quantity: req.body.quantity,
        amount: (req.body.quantity * product.price),
        currency: product.currency,
        authorized: false, // Instrument hasn't been authorized yet
        captured: false // Transaction hasn't been captured yet
    });

    // Charges endpoint that'll be used by Dynamic Forms
    let chargesURL = configPath.url + '/create-charge';

    res.send(`
        <!doctype html>
        <html>
            <div id="dynamic-forms-container" style="max-width: 500px; margin: auto; width: 100%; min-width: 350px;"></div>
            <script src="https://cdn.switchpayments.com/libs/switch-4.stable.min.js"></script>
            <script>
            
                // Dynamic forms options
                let formOptions = {
                    merchantTransactionId: '${orderId}',
                    chargesUrl: '${chargesURL}',
                    showReference : true
                };
                
                // The div where the dynamic forms will be inserted
                let formContainer = document.getElementById('dynamic-forms-container');
                
                // Instantiate the Dynamic Forms
                let switchJs = new SwitchJs(SwitchJs.environments.SANDBOX, '${switchKeys.publicKey}');
                let dynamicForms = switchJs.dynamicForms(formContainer, formOptions);
                
                // Listen to 'instrument-success' event
                dynamicForms.on('instrument-success', (data) => {
                    
                    // If the instrument doesn't have reference to show neither a redirect, we can send the user
                    // to a result page
                    if (data.reference == null && data.redirect == null) {
                        window.location.href = 'http://localhost:${configPath.port}/return?instrumentId=' + data.id;
                    }
                });
            </script>
        </html>
    `);
});

/**
 * Create charge endpoint
 * Creates the charge and responds with the chargeId
 */
app.post('/create-charge', async (req, res) => {

    // Extracts parameters from the body request
    let merchantTransactionId = req.body.merchantTransactionId;
    let chargeType = req.body.chargeType;

    // Gets the order stored in the DB
    let order = DB.getOrder(merchantTransactionId);

    // Body of the POST request
    let body = {
        charge_type: chargeType,
        amount: order.amount,
        currency: order.currency,
        events_url: configPath.url + '/events',
        metadata: {'orderId': merchantTransactionId},
        redirect_url: configPath.url + '/return'
    };

    // Configuration of the POST request
    let config = {
        auth: {
            username: switchKeys.accountId,
            password: switchKeys.privateKey
        }
    };

    // Makes a POST request to the switch api to create a charge
    let responseCharge = await axios.post(switchUrl + 'charges/', body, config);

    // Return the response
    res.send(responseCharge.data);
});

/**
 * Events webhooks
 * Waits for events from the switch API
 */
app.post('/events', async (req, res) => {

    // Configuration of the GET request
    let config = {
        auth: {
            username: switchKeys.accountId,
            password: switchKeys.privateKey
        }
    };

    // Makes a GET request to the switch api to get the instrumentId from the orderId
    let eventResponse = await axios.get(switchUrl + 'events/' + req.query.event, config);

    // Checks if the event_type is 'instrument.authorized'
    if (eventResponse.data.type === 'instrument.authorized') {

        // Gets the order from the DB with the orderId
        let order = DB.getOrder(eventResponse.data.charge.metadata.orderId);

        // Add the instrumentId to the order
        order.instrumentId = eventResponse.data.instrument.id;

        // Marks the order as authorized
        order.authorized = true;

    // Checks if the event_type is 'payment.success'
    } else if (eventResponse.data.type === 'payment.success') {

        // Gets the order from the DB with the orderId
        let order = DB.getOrder(eventResponse.data.charge.metadata.orderId);

        // Add the paymentId to the order
        order.paymentId = eventResponse.data.payment.id;

        // Marks the order as captured
        order.captured = true;
    }

    res.end();
});

/**
 * Return endpoint
 * Checks if the transaction was successful
 */
app.get('/return', async (req, res) => {

    // Get request configuration
    let config = {
        auth: {
            username: switchKeys.accountId,
            password: switchKeys.privateKey
        }
    };

    // Makes a GET request to the switch api to check if the instrument is authorized
    let response = await axios.get(switchUrl + 'instruments/' + req.query.instrumentId, config);

    // Checks if the instrument was authorized
    if (response.data.status === 'authorized') { // Transaction Success
        res.send('<html><h1>Transaction Success</h1></html>');
    }
    // Check if the instrument is pending (the user has not completed the payment yet)
    else if (response.data.status === 'pending') {
        res.send('<html><h1>Waiting for client actions to complete the transaction</h1></html>');
    }
    // Transaction Error
    else {
        res.send('<html><h1>Transaction Error</h1></html>');
    }
});

/**
 * Orders endpoint
 * Shows the orders
 */
app.get('/orders', (req, res) => {
    res.send(DB.orders);
});

// Create a network tunnel to allow Switch API to communicate with the local service
(async function (app, configPath) {
    configPath.url = await ngrok.connect(configPath.port);
    app.listen(configPath.port);
    console.log(`Server running on port ${configPath.port}...`);
})(app, configPath);

// Database
let DB = {
    products: [{
        id: 'sku42',
        name: 'Leather Jacket',
        price: 550,
        currency: 'EUR'
    }],
    orders: [],
    getProduct: (productId) => DB.products.find(product => product.id === productId),
    createOrder: (order) => DB.orders.push(order),
    getOrder: (id) => DB.orders[id - 1]
};
