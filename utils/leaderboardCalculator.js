class LeaderboardCalculator {
  /*** Calculate monthly streak leaderboard with cumulative carry-over*/
  calculateMonthlyLeaderboard(leads, deals, userLogsMap, users, filters) {
    const { year, month } = filters;
    // Date ranges
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0, 23, 59, 59, 999);
    const prevMonthStart = new Date(year, month - 1, 1);
    const prevMonthEnd = new Date(year, month, 0, 23, 59, 59, 999);
    // Initialize salespeople map
    const salespeople = this.initializeSalespeople(users);
    // STEP 1: Process leads with cumulative carry-over
    this.processLeadsWithCarryOver(
      salespeople,
      leads,
      startDate,
      endDate,
      prevMonthStart,
      prevMonthEnd
    );
    // STEP 2: Process deals (conversions)
    this.processDeals(salespeople, deals, startDate, endDate);
    // STEP 3: Process login history for work hours
    this.processLoginHistory(salespeople, userLogsMap, startDate, endDate);
    // STEP 4: Build and return leaderboard
    return this.buildLeaderboard(salespeople);
  }
  /*** Initialize salespeople data structure*/
  initializeSalespeople(users) {
    const salespeople = {};
    users.forEach(user => {
      if (user._id) {
        salespeople[user._id.toString()] = {
          id: user._id.toString(),
          name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email || 'Unknown',
          email: user.email || '',
          totalLeads: 0,
          convertedLeads: 0,
          loginTimestamps: [],
          logoutTimestamps: [],
          dailyLogins: new Map(), // day -> {login, logout}
          carryOverLeads: 0,
          newLeads: 0
        };
      }
    });
    return salespeople;
  }
  /*** Process leads with cumulative carry-over logic* New leads from current month + unfinished leads from previous months*/
  processLeadsWithCarryOver(salespeople, leads, startDate, endDate, prevMonthStart, prevMonthEnd) {
    leads.forEach(lead => {
      const salespersonId = this.extractSalespersonId(lead);
      if (!salespersonId || !salespeople[salespersonId]) return;

      const leadDate = new Date(lead.createdAt);
      const isUnfinished = !this.isLeadConverted(lead);
      // CASE 1: New lead in current month
      if (leadDate >= startDate && leadDate <= endDate) {
        salespeople[salespersonId].totalLeads += 1;
        salespeople[salespersonId].newLeads += 1;
      }
      // CASE 2: CARRY-OVER - Unfinished lead from previous month
      else if (leadDate >= prevMonthStart && leadDate <= prevMonthEnd && isUnfinished) {
        salespeople[salespersonId].totalLeads += 1;
        salespeople[salespersonId].carryOverLeads += 1;
      }
      // CASE 3: Unfinished lead from earlier months (older than previous month)
      else if (leadDate < prevMonthStart && isUnfinished) {
        // Still count as carry-over for ongoing performance tracking
        salespeople[salespersonId].totalLeads += 1;
        salespeople[salespersonId].carryOverLeads += 1;
      }
    });
  }
  /*** Process deals (converted leads)*/
  processDeals(salespeople, deals, startDate, endDate) {
    deals.forEach(deal => {
      const salespersonId = this.extractSalespersonId(deal);
      if (!salespersonId || !salespeople[salespersonId]) return;
      const dealDate = new Date(deal.createdAt);
      // Only count deals converted in the selected month
      if (dealDate >= startDate && dealDate <= endDate) {
        salespeople[salespersonId].convertedLeads += 1;
      }
    });
  }
  /*** Process login/logout history for work hours calculation*/
  processLoginHistory(salespeople, userLogsMap, startDate, endDate) {
    Object.keys(salespeople).forEach(userId => {
      const userLogs = userLogsMap[userId] || [];
      // Filter logs within date range
      const monthLogs = userLogs.filter(log => {
        if (!log?.login) return false;
        const loginDate = new Date(log.login);
        return loginDate >= startDate && loginDate <= endDate;
      });
      // Group by day to find earliest login and latest logout
      const dailySessions = new Map();
      monthLogs.forEach(log => {
        const loginDate = new Date(log.login);
        const dayKey = loginDate.toDateString();
        if (!dailySessions.has(dayKey)) {
          dailySessions.set(dayKey, {
            login: loginDate,
            logout: log.logout ? new Date(log.logout) : null,
            day: dayKey
          });
        } else {
          const session = dailySessions.get(dayKey);
          // Keep earliest login
          if (loginDate < session.login) {
            session.login = loginDate;
          }
          // Keep latest logout
          if (log.logout) {
            const logoutDate = new Date(log.logout);
            if (!session.logout || logoutDate > session.logout) {
              session.logout = logoutDate;
            }
          }
        }
      });
      // Store processed sessions
      salespeople[userId].dailySessions = Array.from(dailySessions.values());
      salespeople[userId].loginTimestamps = monthLogs
        .filter(l => l.login)
        .map(l => new Date(l.login));
      salespeople[userId].logoutTimestamps = monthLogs
        .filter(l => l.logout)
        .map(l => new Date(l.logout));
    });
  }
  /*** Build final leaderboard array  */
  buildLeaderboard(salespeople) {
    const leaderboard = Object.values(salespeople).map(person => {
      const conversionRate = person.totalLeads > 0
        ? (person.convertedLeads / person.totalLeads) * 100
        : 0;
      return {
        // Required fields for leaderboard
        Name: person.name,
        'Performance %': this.formatPercentage(conversionRate),
        'Total Lead Count (including carry-over)': person.totalLeads,
        'Work Hours': this.formatWorkHours(person.dailySessions || []),
        // Additional useful fields for UI
        id: person.id,
        email: person.email,
        convertedLeads: person.convertedLeads,
        newLeads: person.newLeads || 0,
        carryOverLeads: person.carryOverLeads || 0,
        conversionRate: conversionRate,
        activeDays: person.dailySessions?.length || 0,
        // Raw metrics for sorting/filtering
        _raw: {
          conversionRate,
          totalLeads: person.totalLeads,
          convertedLeads: person.convertedLeads,
          activeDays: person.dailySessions?.length || 0
        }
      };
    });
    // Sort by conversion rate descending
    return leaderboard.sort((a, b) => b.conversionRate - a.conversionRate);
  }
  /** Helper: Extract salesperson ID from lead or deal*/
  extractSalespersonId(item) {
    if (!item) return null;
    // Check assignTo (leads)
    if (item.assignTo) {
      if (item.assignTo._id) return item.assignTo._id.toString();
      if (typeof item.assignTo === 'string') return item.assignTo;
    }
    // Check assignedTo (deals)
    if (item.assignedTo) {
      if (item.assignedTo._id) return item.assignedTo._id.toString();
      if (typeof item.assignedTo === 'string') return item.assignedTo;
    }
    return null;
  }
  /*** Helper: Check if lead is converted*/
  isLeadConverted(lead) {
    if (!lead || !lead.status) return false;
    const status = lead.status.toLowerCase();
    return status === 'converted';
  }
  /*** Helper: Format percentage*/
  formatPercentage(value) {
    if (isNaN(value)) return '0.0%';
    return `${value.toFixed(1)}%`;
  }
  /** * Helper: Format work hours as "10:00 AM - 10:00 PM" */
  formatWorkHours(dailySessions) {
    if (!dailySessions || dailySessions.length === 0) {
      return 'No activity';
    }
    // Get earliest login time
    const earliestLogin = dailySessions.reduce((earliest, session) => {
      return session.login < earliest ? session.login : earliest;
    }, dailySessions[0].login);
    // Get latest logout time
    const validLogouts = dailySessions.filter(s => s.logout);
    if (validLogouts.length === 0) {
      return this.formatTimeRange(earliestLogin, null);
    }
    const latestLogout = validLogouts.reduce((latest, session) => {
      return session.logout > latest ? session.logout : latest;
    }, validLogouts[0].logout);
    return this.formatTimeRange(earliestLogin, latestLogout);
  }
  /*** Helper: Format time range*/
  formatTimeRange(start, end) {
    const formatTime = (date) => {
      if (!date) return 'N/A';
      return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
    };
    if (!end) {
      return `${formatTime(start)} - Ongoing`;
    }
    return `${formatTime(start)} - ${formatTime(end)}`;
  }
}
export default new LeaderboardCalculator();