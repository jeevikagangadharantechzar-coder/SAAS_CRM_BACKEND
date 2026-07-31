import mongoose from 'mongoose';
import { Target, Deal, Lead } from './models/index.js'; // Wait, let's just use mongoose models

mongoose.connect('mongodb://127.0.0.1:27017/SAAS_CRM_TECHZAR_CODER').then(async () => {
  const TargetModel = mongoose.model('Target', new mongoose.Schema({}, { strict: false }), 'targets');
  const DealModel = mongoose.model('Deal', new mongoose.Schema({}, { strict: false }), 'deals');
  const LeadModel = mongoose.model('Lead', new mongoose.Schema({}, { strict: false }), 'leads');
  
  const targets = await TargetModel.find({});
  console.log(targets.length + ' targets found.');
  for (const t of targets) {
    const rawLeadIds = (t.linkedLeads || []).map(l => String(l._id || l));
    const rawDealIds = (t.linkedDeals || []).map(d => String(d._id || d));
    
    let leadsConvertedCount = 0;
    if (rawLeadIds.length > 0) {
      leadsConvertedCount = await DealModel.countDocuments({ leadId: { $in: rawLeadIds.map(id => new mongoose.Types.ObjectId(id)) } });
    } else if (t.targetLeads > 0) {
      leadsConvertedCount = await LeadModel.countDocuments({ assignTo: new mongoose.Types.ObjectId(String(t.salesPerson)), status: "Converted" });
    }
    
    let dealsWonCount = 0;
    if (rawDealIds.length > 0) {
      dealsWonCount = await DealModel.countDocuments({ _id: { $in: rawDealIds.map(id => new mongoose.Types.ObjectId(id)) }, stage: "Closed Won" });
    } else if (t.targetDeals > 0) {
      dealsWonCount = await DealModel.countDocuments({ assignedTo: new mongoose.Types.ObjectId(String(t.salesPerson)), stage: "Closed Won" });
    }
    
    console.log(`Target ${t.targetName} (${t.startDate} - ${t.endDate}) -> Leads Converted: ${leadsConvertedCount} / ${Math.max(t.targetLeads || 0, rawLeadIds.length)}, Deals Won: ${dealsWonCount} / ${Math.max(t.targetDeals || 0, rawDealIds.length)}`);
  }
  process.exit(0);
});
