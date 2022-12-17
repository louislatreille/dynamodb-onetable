/*
    debug.ts - Just for debug

    Edit your test case here and invoke via: "jest debug"

    Or run VS Code in the top level directory and just run.
 */
import {Entity, Table} from './utils/init'
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

jest.setTimeout(7200 * 1000)

//  Change with your schema
const schema = {
    format: "onetable:1.1.0",
    version: "1.0.0",
    indexes: {
      primary: { hash: "pk", sort: "sk" },
    },
    models: {
      user: {
        pk: { type: String, value: "U#${userId}" },
        sk: { type: String, value: "-" },
        userId: { type: String, required: true },
        username: { type: String, required: true },
      },
    } as const,
  };

//  Change your table params as required
const table = new Table({
    name: 'oneTableTest',
    client: new DynamoDBClient({ region: "us-east-1" }),
    partial: true,
    schema,
    logger: true,
})

type UserItem = Entity<typeof schema.models.user>;

test('Test', async() => {
    const userModel = table.getModel<UserItem>("user");

    await userModel.create({
      userId: "testUser",
      username: "testUserName",
    });
})