import mongoose from "mongoose";

const calendarNoteSchema = new mongoose.Schema(
  {
    date:      { type: Date, required: true, index: true },
    text:      { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

export default mongoose.model("CalendarNote", calendarNoteSchema);
