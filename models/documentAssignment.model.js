import mongoose from "mongoose";
import documentAssignmentSchema from "./schemas/documentAssignmentSchema.js";

const getDocumentAssignmentModel = (connection) => {
  return connection.model("DocumentAssignment", documentAssignmentSchema);
};

export default getDocumentAssignmentModel;
