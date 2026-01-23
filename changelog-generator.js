// changelog-generator.js
// This script fetches closed Linear tickets, uses AI to analyze them,
// and posts a curated changelog to Slack

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function fetchClosedTickets(startDate, endDate) {
  const query = `
    query {
      issues(
        filter: {
          state: { type: { eq: "completed" } }
          completedAt: { gte: "${startDate}", lte: "${endDate}" }
          team: { id: { eq: "${LINEAR_TEAM_ID}" } }
        }
        first: 100
        orderBy: updatedAt
      ) {
        nodes {
          id
          identifier
          title
          description
          url
          completedAt
          assignee {
            name
          }
          state {
            name
          }
          labels {
            nodes {
              name
            }
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': LINEAR_API_KEY
    },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  
  if (data.errors) {
    throw new Error(`Linear API error: ${data.errors[0].message}`);
  }

  return data.data.issues.nodes;
}

async function analyzeTicketsWithAI(tickets) {
  const ticketSummary = tickets.map((t, i) => 
    `${i + 1}. [${t.identifier}] ${t.title}\n   Description: ${t.description || 'No description'}\n   URL: ${t.url}`
  ).join('\n\n');

  const prompt = `You are analyzing closed product tickets to create a customer-facing changelog. 

Here are ${tickets.length} closed tickets from our Product team:

${ticketSummary}

Your task:
1. Identify which tickets are worth including in a public changelog (user-facing features, improvements, bug fixes)
2. Categorize changelog-worthy items as either "Updates" (major features/changes) or "Small Improvements" (minor enhancements)
3. Select the BEST 3 Updates and BEST 6 Small Improvements
4. For each selected item, write TWO descriptions:
   - "description": A clear, concise sentence describing what the feature/improvement is
   - "marketing_copy": A straightforward sentence explaining what it enables and why it's useful. Use Linear's changelog tone: direct, clear, factual. No hype or marketing fluff. Focus on practical functionality and what users can now do. Keep it brief and professional.
5. Provide brief reasoning for why you selected each item

Respond ONLY with valid JSON in this exact format:
{
  "updates": [
    {
      "identifier": "TICKET-123",
      "url": "https://linear.app/...",
      "description": "Clear, user-friendly sentence describing the update",
      "marketing_copy": "Compelling product-marketing sentence explaining what it is, what it unlocks, and why it's important",
      "reasoning": "Brief explanation of why this was selected"
    }
  ],
  "improvements": [
    {
      "identifier": "TICKET-456",
      "url": "https://linear.app/...",
      "description": "Clear, user-friendly sentence describing the improvement",
      "marketing_copy": "Compelling product-marketing sentence explaining what it is, what it unlocks, and why it's important",
      "reasoning": "Brief explanation of why this was selected"
    }
  ]
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    })
  });

  const data = await response.json();
  const content = data.content[0].text;
  
  // Extract JSON from response (in case there's any preamble)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI did not return valid JSON');
  }
  
  return JSON.parse(jsonMatch[0]);
}

async function postToSlack(analysis, periodStart, periodEnd) {
  const periodText = `${new Date(periodStart).toLocaleDateString()} - ${new Date(periodEnd).toLocaleDateString()}`;
  
  // Format updates as a rich text list
  let updatesText = '';
  if (analysis.updates && analysis.updates.length > 0) {
    updatesText = '🚀 *Updates*\n\n';
    analysis.updates.forEach((item, i) => {
      updatesText += `${i + 1}. ${item.identifier}: ${item.description}\n   ${item.marketing_copy}\n   Link: ${item.url}\n   _${item.reasoning}_\n\n`;
    });
  }

  // Format improvements as a rich text list
  let improvementsText = '';
  if (analysis.improvements && analysis.improvements.length > 0) {
    improvementsText = '✨ *Small Improvements*\n\n';
    analysis.improvements.forEach((item, i) => {
      improvementsText += `${i + 1}. ${item.identifier}: ${item.description}\n   ${item.marketing_copy}\n   Link: ${item.url}\n   _${item.reasoning}_\n\n`;
    });
  }

  // Combine into full changelog text
  const fullChangelog = `📋 *Product Changelog: ${periodText}*\n\n${updatesText}${improvementsText}`;

  // Send to Slack workflow webhook with variables
  // The webhook expects simple key-value pairs that you can reference in your Slack workflow
  const slackMessage = {
    period: periodText,
    updates: updatesText,
    improvements: improvementsText,
    full_changelog: fullChangelog
  };

  const response = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(slackMessage)
  });

  if (!response.ok) {
    throw new Error(`Slack webhook error: ${response.statusText}`);
  }

  return response;
}

function getDateRange() {
  const now = new Date();
  const day = now.getDate();
  
  let startDate, endDate;
  
  // Mid-month run (15th): get tickets from 1st to 15th
  if (day === 15) {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), 15, 23, 59, 59);
  }
  // End of month run: get tickets from 16th to last day
  else {
    startDate = new Date(now.getFullYear(), now.getMonth(), 16);
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  }
  
  return {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString()
  };
}

async function main() {
  try {
    console.log('🚀 Starting changelog generation...');
    
    const { startDate, endDate } = getDateRange();
    console.log(`📅 Fetching tickets from ${startDate} to ${endDate}`);
    
    const tickets = await fetchClosedTickets(startDate, endDate);
    console.log(`✅ Found ${tickets.length} closed tickets`);
    
    if (tickets.length === 0) {
      console.log('ℹ️  No tickets to process. Exiting.');
      return;
    }
    
    console.log('🤖 Analyzing tickets with AI...');
    const analysis = await analyzeTicketsWithAI(tickets);
    console.log(`✅ Selected ${analysis.updates.length} updates and ${analysis.improvements.length} improvements`);
    
    console.log('📤 Posting to Slack...');
    await postToSlack(analysis, startDate, endDate);
    console.log('✅ Changelog posted successfully!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
