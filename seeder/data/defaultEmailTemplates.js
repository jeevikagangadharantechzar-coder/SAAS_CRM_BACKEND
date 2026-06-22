// Default email templates seeded into every tenant database on creation/reset.
// Shared by controllers/tenant.controller.js and seeder/emailTemplatesSeeder.js.

const defaultEmailTemplates = [
  {
    title: "New Lead",
    subject: "Thank You for Your Interest",
    content:
      "Greetings,<br><br>Thank you for connecting with us. Your inquiry has been successfully received and registered in our system as a new lead.<br><br>Our team is currently reviewing the details provided and will reach out shortly to understand your requirements more clearly. We are committed to delivering reliable and result-driven IT solutions tailored to business needs.<br><br>We appreciate the opportunity and look forward to meaningful collaboration.<br><br>Warm regards,<br>The IT Team",
  },
  {
    title: "Qualification",
    subject: "Lead Successfully Moved to Qualification Stage",
    content:
      "Greetings,<br><br>We are pleased to inform you that your request has successfully progressed to the deal qualification stage.<br><br>Our team is carefully evaluating the scope, feasibility, and requirements to ensure the best possible approach. This step allows us to align our expertise with your expectations effectively.<br><br>We look forward to moving ahead with structured discussions and delivering value-driven solutions.<br><br>Sincerely,<br>The IT Team",
  },
  {
    title: "Deal Won",
    subject: "Project Successfully Closed & Confirmed",
    content:
      "Greetings,<br><br>We are delighted to inform you that the deal has been successfully finalized and confirmed.<br><br>It is a privilege to collaborate on this engagement, and our team is fully committed to delivering excellence throughout the project lifecycle. We truly value this opportunity and look forward to supporting future initiatives as well.<br><br>Thank you for your trust and partnership.<br><br>Best regards,<br>The IT Team",
  },
  {
    title: "Services",
    subject: "Overview of Our IT Services & Expertise",
    content:
      "Greetings,<br><br>We would like to share an overview of our core IT services and capabilities.<br><br>Our expertise includes custom software development, web and mobile applications, cloud solutions, IT consulting, cybersecurity services, system integration, and long-term technical support. We focus on scalable architecture, performance optimization, and secure implementations.<br><br>We are always ready to contribute with innovative and efficient technology solutions.<br><br>Kind regards,<br>The IT Team",
  },
  {
    title: "Holiday Notice",
    subject: "Official Holiday Notification",
    content:
      "Greetings,<br><br>Please be informed that our office will remain closed on the upcoming weekend/holiday. During this period, regular operations and support services may be temporarily unavailable.<br><br>All communications received during the holiday will be addressed promptly on the next working day.<br><br>We appreciate your understanding and continued cooperation.<br><br>Thank you,<br>The IT Team",
  },
  {
    title: "Commitment",
    subject: "Dedicated to Meeting Your Expectations",
    content:
      "Greetings,<br><br>Our organization remains committed to delivering solutions that align with your expectations and business objectives.<br><br>We continuously strive for quality, transparency, and performance excellence in every engagement. Client satisfaction remains our top priority, and we value long-term professional relationships built on trust and results.<br><br>We look forward to exceeding expectations in every collaboration.<br><br>Warm regards,<br>The IT Team",
  },
  {
    title: "Follow-Up",
    subject: "Awaiting Your Response",
    content:
      "Greetings,<br><br>We hope this message finds you well.<br><br>We would like to gently follow up regarding our previous communication. Our team is currently awaiting your response to proceed further with the next steps.<br><br>Please feel free to share any updates or clarifications at your convenience. We remain ready to assist and move forward as soon as we hear from you.<br><br>Looking forward to your response.<br><br>Best wishes,<br>The IT Team",
  },
  {
    title: "Custom",
    subject: "[Custom Subject – Editable]",
    content:
      "Greetings,<br><br>This is a customizable email template designed for specific communication needs. The content can be modified as required to address unique situations, updates, or announcements.<br><br>Please update the subject and message body accordingly before sending.<br><br>Thank you,<br>The IT Team",
  },
  {
    title: "New Opportunity",
    subject: "Exploring New Opportunities Together",
    content:
      "Greetings,<br><br>We hope everything is progressing well following the successful completion of our recent engagement. It was truly a pleasure delivering the project and collaborating throughout the process.<br><br>Our team would be delighted to explore any upcoming initiatives, enhancements, or new projects where we can continue to contribute value. We remain fully prepared to support future requirements with the same dedication and quality commitment.<br><br>We look forward to the possibility of working together again.<br><br>Warm regards,<br>The IT Team",
  },
  {
    title: "Clarification",
    subject: "Request for Additional Information",
    content:
      "Greetings,<br><br>We hope this message finds you well.<br><br>To proceed efficiently with the next phase of discussion, we kindly request a few additional details or clarifications regarding your requirements. This will help us ensure accurate planning, proper resource allocation, and the best possible outcome.<br><br>Please feel free to share the necessary information at your convenience. Our team remains available for any further discussion or assistance.<br><br>We look forward to your response.<br><br>Warm regards,<br>The IT Team",
  },
];

export default defaultEmailTemplates;
