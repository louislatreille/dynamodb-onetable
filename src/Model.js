/*
    Model.js - DynamoDB model class
*/
import Expression from './Expression.js'

/*
    Default index keys if not supplied
 */
const DefaultIndexes = {
    primary: {
        hash: 'pk',
        sort: 'sk',
    },
}

/*
    DynamoDB API methods mapped to dynamo
 */
const DocumentClientMethods = {
    delete: 'delete',
    get: 'get',
    find: 'query',
    put: 'put',
    scan: 'scan',
    update: 'update'
}

/*
    Ready / write tags for interceptions
 */
const InterceptTags = {
    delete: 'write',
    get: 'read',
    find: 'read',
    put: 'write',
    scan: 'read',
    update: 'write'
}

const TransactOps = { delete: 'Delete', get: 'Get', put: 'Put', update: 'Update' }
const BatchOps = { delete: 'DeleteRequest', put: 'PutRequest', update: 'PutRequest' }
const SanityPages = 1000
const FollowThreads = 10

/*
    DynamoDB model entity class
 */
export default class Model {

    /*
        @param table Instance of Table.
        @param name Name of the model.
        @param options Hash of options.
     */
    constructor(table, name, options = {}) {
        if (!table) {
            throw new Error('Missing table argument')
        }
        if (!table.typeField || !table.ulid) {
            throw new Error('Invalid table instance')
        }
        if (!name) {
            throw new Error('Missing name of model')
        }
        this.table = table
        this.name = name
        this.options = options

        //  Cache table properties
        this.V3 = table.V3
        this.createdField = table.createdField
        this.delimiter = table.delimiter
        this.log = table.log.bind(table)
        this.nulls = table.nulls || false
        this.tableName = table.name
        this.typeField = table.typeField
        this.timestamps = options.timestamps
        if (this.timestamps == null) {
            this.timestamps = table.timestamps || true
        }
        this.updatedField = table.updatedField

        /*
            Migration functions can be provided to Table or via the schema.
         */
        this.intercept = options.intercept
        this.indexes = options.indexes || DefaultIndexes
        this.indexProperties = this.getIndexProperties(this.indexes)

        this.fields = {}            //  Attribute list for this model
        this.map = {}               //  Map properties to attributes and vice-versa
        this.reverse = {}

        if (options.fields) {
            this.prepModel(options.fields)
        }
    }

    /*
        Prepare a model based on field schema and compute the attribute mapping/reverse mapping.
     */
    prepModel(fields) {
        fields = Object.assign({}, fields)
        fields[this.typeField] = { type: String }
        if (this.timestamps) {
            fields[this.createdField] = fields[this.createdField] || { type: Date }
            fields[this.updatedField] = fields[this.updatedField] || { type: Date }
        }
        for (let [name, field] of Object.entries(fields)) {
            if (!field.type) {
                field.type = String
            }
            let to = field.map
            if (to) {
                this.map[name] = to
                this.reverse[to] = name
            } else {
                this.map[name] = name
                this.reverse[name] = name
            }
            field.name = name
            field.attribute = this.map[name]
            if (field.nulls !== true && field.nulls !== false) {
                field.nulls = this.nulls
            }
            if (this.indexProperties[this.map[name]]) {
                field.isIndexed = true
                field.hidden = field.hidden || this.table.hidden
            }
            this.fields[name] = field
        }

        let primary = this.indexes.primary
        let {hash, sort} = this.indexes.primary
        this.fields[this.reverse[hash]].required = true
        this.fields[this.reverse[sort]].required = true

        if (!this.reverse[primary.hash] || !this.reverse[primary.sort]) {
            throw new Error(`dynamo: Cannot find primary keys for model ${this.name} in primary index`)
        }
        if (Object.values(this.fields).find(f => f.unique && f.attribute != hash && f.attribute != sort)) {
            this.hasUniqueFields = true
        }
    }

    /*
        Run an operation on DynamodDB. The command has been parsed via Expression.
        Returns [] for find/scan, cmd if !execute, else returns item.
     */
    async run(op, expression) {
        let {properties, params} = expression

        /*
            Get a string representation of the API request
         */
        let cmd = expression.prepare()
        if (!expression.execute) {
            return cmd
        }
        /*
            Transactions save the command in params.transaction and wait for db.transaction() to be called.
         */
        let t = params.transaction
        if (t) {
            let top = TransactOps[op]
            if (top) {
                params.expression = expression
                let items = t.TransactItems = t.TransactItems || []
                return items.push({[top]: cmd})
            } else {
                throw new Error(`Unknown transaction operation ${op}`)
            }
        }
        /*
            Batch operations save the command in params.transaction and wait for db.batchGet|batchWrite to be called.
         */
        let b = params.batch
        if (b) {
            params.expression = expression
            let items = b.RequestItems = b.RequestItems || {}
            if (op == 'get') {
                let list = items[this.tableName] = items[this.tableName] || {Keys: []}
                return list.Keys.push(cmd.Keys)
            } else {
                let list = items[this.tableName] = items[this.tableName] || []
                let bop = BatchOps[op]
                return list.push({[bop]: cmd})
            }
        }

        /*
            Run command. Paginate if required.
         */
        let mark = new Date()
        let trace = {cmd, op, properties, params}
        let pages = 0, items = [], metrics, result
        let limit = cmd.Limit ? cmd.Limit : null
        do {
            try {
                this.log('trace', `Dynamo "${op}" "${this.name}"`, trace, params)
                if (limit) {
                    cmd.Limit = limit
                }
                if (this.V3) {
                    result = await this.table.client[op](cmd)
                } else {
                    result = await this.table.client[DocumentClientMethods[op]](cmd).promise()
                }

            } catch (err) {
                if (params.throw === false) {
                    result = {}
                } else if (op = 'update' && err.code == 'ConditionalCheckFailedException' && params.throw !== true) {
                    result = {}
                } else {
                    trace.err = err
                    this.log('error', `Dynamo exception in "${op}" on "${this.name}"`, trace, params)
                    throw err
                }
            }
            if (result.LastEvaluatedKey) {
                //  Resume next page
                cmd.ExclusiveStartKey = result.LastEvaluatedKey
            }
            if (result.Items) {
                items = items.concat(result.Items)
                if (params.metrics) {
                    metrics = metrics || {count: 0, scanned: 0, capacity: 0}
                    metrics.count += result.Count
                    metrics.scanned += result.ScannedCount
                    metrics.capacity += result.ConsumedCapacity
                }
            } else if (result.Item) {
                items = [result.Item]
                break
            } else if (result.Attributes) {
                items = [result.Attributes]
                break
            }
            if (limit) {
                limit -= items.length
                if (limit <= 0) {
                    break
                }
            }
        } while (result.LastEvaluatedKey && (limit == null || pages++ < SanityPages))

        if (params.parse) {
            items = this.parseResponse(op, expression, items)
        }
        if (params.follow) {
            if (op == 'get') {
                return await this.get(items[0])
            }
            if (op == 'find') {
                let results = [], promises = []
                for (let item of items) {
                    promises.push(this.get(item))
                    if (promises.length > FollowThreads) {
                        results = results.concat(await Promise.all(promises))
                        promises = []
                    }
                }
                if (promises.length) {
                    results = results.concat(await Promise.all(promises))
                }
                return results
            }
        }
        if (params.log !== false) {
            trace.elapsed = (new Date() - mark) / 1000
            trace.items = items
            this.log('data', `Dynamo "${op}" "${this.name}"`, trace, params)
        }
        if (op == 'find' || op == 'scan') {
            if (metrics) {
                items.count = metrics.Count
                items.scanned = metrics.ScannedCount
                items.capacity = metrics.ConsumedCapacity
                items.start = result.LastEvaluatedKey
            }
            if (result.LastEvaluatedKey) {
                /*
                    More results to come. Create a next() iterator.
                 */
                let params = expression.params
                let properties = expression.properties
                items.next = async () => {
                    params = Object.assign({}, params, {start: result.LastEvaluatedKey})
                    if (!params.high) {
                        if (op == 'find') op = 'queryItems'
                        else if (op == 'scan') op = 'scanItems'
                    }
                    return await this[op](properties, params)
                }
            }
            return items
        }
        return items[0]
    }

    /*
        Parse the response into Javascript objects for the high level API.
     */
    parseResponse(op, expression, items) {
        let table = this.table
        if (op == 'put') {
            items = [expression.getFieldValues()]
        } else {
            items = table.unmarshall(items)
        }
        for (let [index, item] of Object.entries(items)) {
            if (expression.params.high && item[this.typeField] != this.name) {
                //  High level API and item for a different model
                continue
            }
            let type = item[this.typeField] ? item[this.typeField] : this.name
            let model = table.models[type] ? table.models[type] : this
            if (model) {
                if (model == table.unique) {
                    //  Special "unique" model for unique fields. Don't return in result.
                    continue
                }
                items[index] = model.mapReadData('find', item, expression.params)
            }
        }
        return items
    }

    async create(properties, params = {}) {
        this.checkArgs(properties, params)
        params = Object.assign({parse: true, high: true, exists: false}, params)
        let result
        if (this.hasUniqueFields) {
            result = await this.createUnique(properties, params)
        } else {
            result = await this.putItem(properties, params)
        }
        return result
    }

    /*
        Create an item with unique attributes. Use a transaction to create a unique item for each
        unique attribute.
     */
    async createUnique(properties, params) {
        let transaction = params.transaction = params.transaction || {}
        let {hash, sort} = this.indexes.primary
        let fields = Object.values(this.fields).filter(f => f.unique && f.attribute != hash && f.attribute != sort)
        for (let field of fields) {
            await this.table.unique.create({pk: `${this.name}:${field.attribute}:${properties[field.name]}`}, {
                transaction,
                exists: false,
                return: 'NONE',
            })
        }
        await this.putItem(properties, params)
        let expression = params.expression
        try {
            await this.table.transact('write', params.transaction, params)
        } catch (err) {
            if (err.message.indexOf('ConditionalCheckFailed') >= 0) {
                throw new Error(`dynamo: Cannot create "${this.name}", an item of the same name already exists.`)
            }
        }
        let items = this.parseResponse('put', expression)
        return items[0]
    }

    async find(properties = {}, params = {}) {
        this.checkArgs(properties, params)
        params = Object.assign({parse: true, high: true}, params)
        return await this.queryItems(properties, params)
    }

    async get(properties, params = {}) {
        this.checkArgs(properties, params)
        params = Object.assign({parse: true, high: true}, params)
        let expression = new Expression(this, 'get', properties, params)
        if (expression.fallback) {
            let items = await this.find(properties, params)
            if (items.length > 1) {
                this.log('info', `Get fallback with more than one result`, {model: this.name, properties, params})
            }
            return items[0]
        }
        return await this.run('get', expression)
    }

    async remove(properties, params = {}) {
        this.checkArgs(properties, params)
        params = Object.assign({exists: null, high: true}, params)
        let expression = new Expression(this, 'delete', properties, params)
        if (expression.fallback) {
            return await this.removeByFind(properties, params)
        }
        if (this.hasUniqueFields) {
            await this.removeUnique(properties, params)
        } else {
            await this.run('delete', expression)
        }
    }

    /*
        Remove multiple objects after doing a full find/query
     */
    async removeByFind(properties, params) {
        if (params.retry) {
            throw new Error('dynamo: Remove cannot retry')
        }
        let items = await this.find(properties, params)
        if (items.length > 1 && !params.many) {
            throw new Error(`dynamo: warning: removing multiple items from "${this.name}". Use many:true to enable.`)
        }
        for (let item of items) {
            await this.remove(item, {retry: true})
        }
    }

    /*
        Remove an item with unique properties. Use transactions to remove unique items.
     */
    async removeUnique(properties, params) {
        let transaction = params.transaction = params.transaction || {}
        let {hash, sort} = this.indexes.primary
        let fields = Object.values(this.fields).filter(f => f.unique && f.attribute != hash && f.attribute != sort)
        for (let field of fields) {
            await this.table.unique.remove({pk: `${this.name}:${field.attribute}:${properties[field.name]}`}, {transaction})
        }
        await this.deleteItem(properties, params)
        await this.table.transact('write', params.transaction, params)
    }

    async scan(properties = {}, params = {}) {
        this.checkArgs(properties, params)
        params = Object.assign({parse: true, high: true}, params)
        properties = Object.assign({}, properties)
        properties[this.typeField] = this.name
        return await this.scanItems(properties, params)
    }

    async update(properties, params = {}) {
        params = Object.assign({exists: true, parse: true, high: true}, params)
        return await this.updateItem(properties, params)
    }

    async updateByFind(properties, params) {
        if (params.retry) {
            throw new Error(`dynamo: Update retry failed for ${this.name}`, {properties, params})
        }
        let grid = await this.find(properties, params)
        if (grid.length != 1) {
            throw new Error('dynamo: cannot update multiple items')
        }
        let primary = this.indexes.primary
        let {hash, sort} = primary
        properties[hk] = grid[0][this.reverse[hash]]
        properties[sk] = grid[0][this.reverse[sort]]
        return await this.update(properties, {retry: true})
    }

    //  Low level API

    /* private */ async deleteItem(properties, params = {}) {
        let expression = new Expression(this, 'delete', properties, params)
        await this.run('delete', expression)
    }

    /* private */ async getItem(properties, params = {}) {
        let expression = new Expression(this, 'get', properties, params)
        return await this.run('get', expression)
    }

    /* private */ async putItem(properties, params = {}) {
        properties = Object.assign({}, properties)
        properties[this.typeField] = this.name
        if (this.timestamps) {
            properties[this.updatedField] = properties[this.createdField] = new Date()
        }
        properties = this.validate('put', properties, params)
        let expression = new Expression(this, 'put', properties, params)
        return await this.run('put', expression)
    }

    /* private */ async queryItems(properties = {}, params = {}) {
        let expression = new Expression(this, 'find', properties, params)
        return await this.run('find', expression)
    }

    //  Note: scanItems will return all model types
    /* private */ async scanItems(properties = {}, params = {}) {
        let expression = new Expression(this, 'scan', properties, params)
        return await this.run('scan', expression)
    }

    /* private */ async updateItem(properties, params = {}) {
        properties = Object.assign({}, properties)
        properties[this.typeField] = this.name
        if (this.timestamps) {
            properties[this.updatedField] = new Date()
        }
        properties = this.validate('update', properties, params)
        let expression = new Expression(this, 'update', properties, params)
        if (expression.fallback) {
            return await this.updateByFind(properties, params)
        }
        return await this.run('update', expression)
    }

    /*
        Map Dynamo types to Javascript types after reading data
     */
    mapReadData(op, result, params) {
        if (!result) {
            return result
        }
        let rec = {}
        let fields = this.fields
        let reverse = this.reverse

        for (let [name, field] of Object.entries(this.fields)) {
            let attribute = this.map[name]
            let value = result[attribute]
            if (value === undefined) {
                if (field.default) {
                    if (typeof field.default == 'function') {
                        value = field.default(this, fieldName, properties)
                    } else {
                        value = field.default
                    }
                } else {
                    continue
                }
            }
            if (field.crypt) {
                value = this.decrypt(value)
            }
            //  Invoke custom data transform after reading
            if (field.transform) {
                rec[name] = field.transform(this, 'read', name, value)
            } else if (field.type == Date) {
                rec[name] = value ? new Date(value) : null
            } else if (field.type == Buffer || field.type == 'Binary') {
                rec[name] = new Buffer(value, 'base64')
            } else {
                rec[name] = value
            }
        }
        if (this.intercept && InterceptTags[op] == 'read') {
            rec = this.intercept(this, op, rec, result)
        }
        for (let [name, field] of Object.entries(this.fields)) {
            if (field.hidden && params.hidden !== true) {
                delete rec[name]
            }
        }
        return rec
    }

    /*
        Map types before writing data to Dynamo
     */
    mapWriteData(field, value) {
        if (field.type == Date) {
            if (this.table.isoDates) {
                if (value instanceof Date) {
                    value = value.toISOString()
                } else if (typeof value == 'string') {
                    value = (new Date(Date.parse(value))).toISOString()
                } else if (typeof value == 'number') {
                    value = (new Date(value)).toISOString()
                }
            } else {
                //  Convert dates to unix epoch
                if (value instanceof Date) {
                    value = value.getTime()
                } else if (typeof value == 'string') {
                    value = (new Date(Date.parse(value))).getTime()
                }
            }

        } else if (field.type == Buffer || field.type == 'Binary') {
            // FUTURE: File, Blob, ArrayBuffer, DataView, and typed arrays
            if (value instanceof Buffer) {
                value = value.toString('base64')
            }
        } else if (field.type == 'Set') {
            if (!Array.isArray(value)) {
                throw new Error('Set value must be an array')
            }
        }
        if (value != null && typeof value == 'object') {
            value = this.mapNestedFields(field, value)
        }
        //  Invoke custom transformation before writing data
        if (field.transform) {
            value = field.transform(this, 'write', field.name, value)
        }
        if (field.crypt) {
            value = this.encrypt(value)
        }
        return value
    }

    mapNestedFields(field, obj) {
        for (let [key, value] of Object.entries(obj)) {
            if (value instanceof Date) {
                obj[key] = value.getTime()
            } else if (value == null && field.nulls !== true) {
                //  Skip nulls
                continue
            } else if (typeof value == 'object') {
                obj[key] = this.mapNestedFields(field, value)
            }
        }
        return obj
    }

    /*
        Validate properties and map types before writing to the database.
     */
    validate(op, properties, params) {
        let context = params.context ? params.context : this.table.context
        let result = {}
        let details = {}

        /*
            Loop over all fields and validate. Loop over fields vs properties.
            Necessary as keys, composite keys and other fields may use templates
            to create composite field values.
         */
        for (let [fieldName, field] of Object.entries(this.fields)) {
            let value = properties[fieldName]
            if (op == 'put') {
                if (field.required && value == null && field.value == null) {
                    if (context[fieldName] !== undefined) {
                        value = context[fieldName]
                    } else if (field.ulid) {
                        value = this.table.ulid()
                    } else if (field.ksuid) {
                        value = this.table.ksuid()
                    } else if (field.uuid) {
                        value = this.table.uuid()
                    } else {
                        details[fieldName] = `Missing required "${fieldName}"`
                        continue
                    }
                }
            }
            if (value === undefined) {
                if (op == 'put' && field.default) {
                    if (typeof field.default == 'function') {
                        value = field.default(this, fieldName, properties)
                    } else {
                        value = field.default
                    }
                }
                if (value === undefined) {
                    continue
                }
            }
            let validate = field.validate
            if (validate) {
                if (!value) {
                    if (field.required && field.value == null) {
                        if (context[fieldName] !== undefined) {
                            value = context[fieldName]
                        } else {
                            details[fieldName] = `Value not defined for "${fieldName}"`
                        }
                    }
                } else if (typeof validate == 'function') {
                    ({error, value} = validate(this, field, value))
                    if (error) {
                        details[fieldName] = msg
                    }
                } else if (validate instanceof RegExp) {
                    if (!validate.exec(value)) {
                        details[fieldName] = `Bad value \"${value}\" for "${fieldName}"`
                    }
                } else {
                    let pattern = validate.toString()
                    if (pattern[0] == '/' && pattern.lastIndexOf('/') > 0) {
                        let parts = pattern.split('/')
                        let qualifiers = parts.pop()
                        let pat = parts.slice(1).join('/')
                        validate = new RegExp(pat, qualifiers)
                        if (!validate.exec(value)) {
                            details[fieldName] = `Bad value \"${value}\" for "${fieldName}"`
                        }
                    } else {
                        if (!value.match(pattern)) {
                            details[fieldName] = `Bad value \"${value}\" for "${fieldName}"`
                        }
                    }
                }
                if (field.length && value) {
                    if (value.length != field.length) {
                        details[fieldName] = `Bad length of value "${value}" for "${fieldName}"`
                    }
                }
            }
            if (field.enum) {
                if (value) {
                    if (field.enum.indexOf(value) < 0) {
                        details[fieldName] = `Bad value \"${value}\" for "${fieldName}"`
                    }
                }
            }
            result[fieldName] = this.mapWriteData(field, value)
        }
        if (Object.keys(details).length > 0) {
            this.log('info', `Validation error for "${this.name}"`, {model: this.name, properties, details})
            let err = new Error(`dynamo: Validation Error for "${this.name}"`)
            err.details = details
            throw err
        }
        if (this.intercept && InterceptTags[op] == 'write') {
            result = this.intercept(this, this.op, result)
        }
        return result
    }

    /*
        Get a hash of all the property names of the indexes
     */
    getIndexProperties(indexes) {
        let properties = {}
        for (let index of Object.values(indexes)) {
            for (let name of Object.values(index)) {
                properties[name] = true
            }
        }
        return properties
    }

    encrypt(text, name = 'primary', inCode = 'utf8', outCode = 'base64') {
        return this.table.encrypt(text, name, inCode, outCode)
    }

    decrypt(text, inCode = 'base64', outCode = 'utf8') {
        return this.table.decrypt(text, inCode, outCode)
    }

    checkArgs(properties, params) {
        if (!properties) {
            throw new Error('Invalid properties')
        }
        if (typeof params != 'object') {
            throw new Error('Invalid type for params')
        }
    }
}
