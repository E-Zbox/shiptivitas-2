import express from "express";
import Database from "better-sqlite3";

const app = express();

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
    return res.status(200).send({
        message: "SHIPTIVITY API. Read documentation to see API docs",
    });
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database("./clients.db");

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on("SIGTERM", closeDb);
process.on("SIGINT", closeDb);

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
    if (Number.isNaN(id)) {
        return {
            valid: false,
            messageObj: {
                message: "Invalid id provided.",
                long_message: "Id can only be integer.",
            },
        };
    }
    const client = db
        .prepare("select * from clients where id = ? limit 1")
        .get(id);
    if (!client) {
        return {
            valid: false,
            messageObj: {
                message: "Invalid id provided.",
                long_message: "Cannot find client with that id.",
            },
        };
    }
    return {
        valid: true,
    };
};

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
    if (Number.isNaN(priority)) {
        return {
            valid: false,
            messageObj: {
                message: "Invalid priority provided.",
                long_message: "Priority can only be positive integer.",
            },
        };
    }
    return {
        valid: true,
    };
};

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get("/api/v1/clients", (req, res) => {
    const status = req.query.status;
    if (status) {
        // status can only be either 'backlog' | 'in-progress' | 'complete'
        if (
            status !== "backlog" &&
            status !== "in-progress" &&
            status !== "complete"
        ) {
            return res.status(400).send({
                message: "Invalid status provided.",
                long_message:
                    "Status can only be one of the following: [backlog | in-progress | complete].",
            });
        }
        const clients = db
            .prepare("select * from clients where status = ?")
            .all(status);
        return res.status(200).send(clients);
    }
    const statement = db.prepare("select * from clients");
    const clients = statement.all();
    return res.status(200).send(clients);
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get("/api/v1/clients/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { valid, messageObj } = validateId(id);
    if (!valid) {
        res.status(400).send(messageObj);
    }
    return res
        .status(200)
        .send(db.prepare("select * from clients where id = ?").get(id));
});

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
app.put("/api/v1/clients/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { valid, messageObj } = validateId(id);
    if (!valid) {
        res.status(400).send(messageObj);
    }

    let { status, priority } = req.body;

    /* ---------- Update code below ----------*/

    if (priority) {
        priority = Number(priority);
    }
    /**
     * i.     first of we need to check if the status || priority of client is to be updated - update it
     * ii.    update priority of all members with client's status
     * iii.   perform final update to previous client's status if there was such
     */
    const client = db.prepare("SELECT * FROM clients WHERE id=?").get(id);
    let clientPreviousStatus = client.status;
    let clientsWithPreviousStatus = db
        .prepare(
            "SELECT * FROM clients WHERE status=? AND id<>? ORDER BY priority ASC"
        )
        .all(clientPreviousStatus, client.id);

    if (status && client.status !== status) {
        // update client status
        client.status = status;
    }

    if (priority && client.priority !== priority) {
        // we need to update client priority
        client.priority = priority;
    }

    // update priority of all members with client's status
    let clientsWithCurrentStatus = db
        .prepare("SELECT * FROM clients WHERE status=? ORDER BY priority")
        .all(client.status);
    // note that: if client status was not meant to change, all we do here is update the priorities alone if necessary
    let count = 0;

    clientsWithCurrentStatus.forEach((_client, index) => {
        // if we encounter the same client (i.e `id` is the same), we ignore it
        if (_client.id == client.id) return;

        /**
         * if we encounter a client with the current priority, we update both client's priorities
         * i.e - our client (1st) then the next client
         */
        if (_client.priority === client.priority) {
            count = 1;
            // let's update client's priority and status
            db.prepare(
                "UPDATE clients SET status=?, priority=? WHERE id=?"
            ).run(client.status, client.priority, client.id);
            // update _client's priority
            db.prepare("UPDATE clients SET priority=? WHERE id=?").run(
                _client.priority + count,
                _client.id
            );
            // count++;
        }

        // let's check if value of count got updated, update _client.priority by +count if _client.priority is less than client's priority
        if (_client.priority > client.priority && count == 1) {
            // update _client's priority
            db.prepare("UPDATE clients SET priority=? WHERE id=?").run(
                _client.priority + count,
                _client.id
            );
        }
    });

    // also check if client's priority is the least (i.e 1 is highest priority and any priority >= the amount of client's with this status), update it
    if (client.priority >= clientsWithCurrentStatus.length) {
        // update client's priority and status?
        db.prepare("UPDATE clients SET status=?, priority=? WHERE id=?").run(
            client.status,
            client.priority,
            client.id
        );
    }

    // if client had a previous status, let's update the priorites of all the members with that previous status
    if (priority) {
        clientsWithPreviousStatus.forEach((_client, index) => {
            if (_client.priority !== index + 1) {
                // update this _client's priority
                return db
                    .prepare("UPDATE clients SET priority=? WHERE id=?")
                    .run(index + 1, _client.id);
            }
        });
    }

    // fetch updated clients status
    const clients = db
        .prepare("SELECT * FROM clients WHERE status=? ORDER BY priority")
        .all(client.status);

    return res.status(200).send(clients);
});

app.listen(3001, () => console.log("app running on port ", 3001));
