import mongoose from "mongoose";

// A personal sticky-note reminder pinned to a date on the Schedule page —
// private to whoever created it, not a team-visible record like tasks/
// deals/etc. Purely a "don't let me forget" scratchpad.
const calendarNoteSchema = new mongoose.Schema(
  {
    date:      { type: Date, required: true, index: true },
    text:      { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

export default calendarNoteSchema;
