import mongoose from "mongoose";
import externalDocumentSchema from "./schemas/externalDocumentSchema.js";

const ExternalDocument = mongoose.model("ExternalDocument", externalDocumentSchema);
export default ExternalDocument;
