import 'preact/devtools';
import { render } from 'preact';
import { Suspense } from 'react';

import { Tab } from '@headlessui/react';

import { TestComp, TestWrapper } from './LazyBarrier';

export function App() {
	return (
		<Suspense fallback={<p>Loading...</p>}>
			<Tab.Group>
				<Tab>
					<div>Foo</div>
				</Tab>
				<div>
					<TestWrapper>
						<TestComp />
					</TestWrapper>
				</div>
			</Tab.Group>
		</Suspense>
	);
}

render(<App />, document.body);
