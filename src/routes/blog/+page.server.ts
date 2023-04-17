import { error } from '@sveltejs/kit';

const query = `
query GetPosts {
    posts {
      nodes {
        id
        title
        date
        content(format: RENDERED)
        featuredImage {
          node {
            sourceUrl
            altText
          }
        }
      }
    }
  }
 `;
const apiURL = 'https://endless-process.net/graphql';

export async function load({ fetch }) {
	const response = await fetch(apiURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ query })
	});

	if (response.ok) {
		const responseObj = await response.json();
		const posts = responseObj.data.posts.nodes;

		return {
			posts
		};
	}
	//todo: handle error with SvelteKit error page
	if (!response) throw error(404);
}