import express from 'express'
import mysql from 'mysql'
import cors from 'cors'
import { configDB } from './configDB.js'

const db = mysql.createConnection(configDB)
const app = express()
app.use(cors())
app.use(express.json())
const port = 8000

console.log(port)


app.listen(port, ()=> console.log("Server is listening on port: " + port))