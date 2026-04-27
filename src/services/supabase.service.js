const { createClient } = require('@supabase/supabase-js')

const TEST_MEMBER_ID = '87a11cda-5ef9-4933-a664-70915551d681'

let _client = null
let _db = null

function getClient() {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { db: { schema: 'v57' } }
    )
  }
  return _client
}

function db() {
  if (!_db) _db = getClient().schema('v57')
  return _db
}

async function testConnection() {
  const { error } = await db().from('projects').select('id').limit(1)
  if (error) throw error
  return true
}

function calculateCost(tokens_used) {
  const input_cost = (tokens_used.input || 0) * 0.0000003
  const output_cost = (tokens_used.output || 0) * 0.0000025
  return parseFloat((input_cost + output_cost).toFixed(6))
}

module.exports = { db, getClient, testConnection, TEST_MEMBER_ID, calculateCost }
